const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  // Keep connections alive for long movie sessions
  pingTimeout: 60000,   // 60s before considering a connection dead
  pingInterval: 25000,  // Ping every 25s
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── Health-check endpoint (used by UptimeRobot / cron to prevent server sleep)
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

// ─── Room store ────────────────────────────────────────────────────────────────
const rooms = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRoomId() {
  return uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();
}

function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function getRoomForSocket(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.users.some(u => u.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function broadcastUserList(roomId, room) {
  io.to(roomId).emit('user-list', {
    users: room.users.map(u => ({
      displayName: u.displayName,
      isHost: u.socketId === room.hostSocketId
    }))
  });
}

function scheduleRoomDelete(roomId, room) {
  if (room._deleteTimer) return;
  room._deleteTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.users.length === 0) {
      // Stop the sync interval before deleting
      if (r._syncInterval) clearInterval(r._syncInterval);
      rooms.delete(roomId);
      console.log(`[room-expired] ${roomId}`);
    }
  }, 60_000);
}

// ─── Periodic sync broadcast (keeps long movies in sync even with drift) ──────
// Every 30s the server broadcasts the authoritative playback state to all users
function startSyncInterval(roomId, room) {
  if (room._syncInterval) return;
  room._syncInterval = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r || r.users.length < 2) return;
    // Only broadcast if playing (paused videos don't drift)
    if (r.playbackState.isPlaying) {
      const elapsed = (Date.now() - r.playbackState.lastSyncedAt) / 1000;
      const estimatedTime = r.playbackState.currentTime + elapsed;
      io.to(roomId).emit('heartbeat-sync', {
        currentTime: estimatedTime,
        isPlaying: r.playbackState.isPlaying
      });
    }
  }, 30_000);
}

// ─── Socket events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Validate room (home.js join flow — no side effects) ───────────────────
  socket.on('check-room', ({ roomId }) => {
    const id = (roomId || '').trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('room-error', { message: `Room "${id}" not found. Check the code and try again.` });
      return;
    }
    socket.emit('room-checked', { roomId: id, videoId: room.videoId });
  });

  // ── Create room ───────────────────────────────────────────────────────────
  socket.on('create-room', ({ displayName, videoUrl }) => {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      socket.emit('room-error', { message: 'Invalid YouTube URL or video ID.' });
      return;
    }
    const roomId = generateRoomId();
    const room = {
      roomId,
      hostSocketId: null,
      creatorName: displayName,
      videoId,
      playbackState: { isPlaying: false, currentTime: 0, lastSyncedAt: Date.now() },
      users: [],
      _deleteTimer: null,
      _syncInterval: null
    };
    rooms.set(roomId, room);
    scheduleRoomDelete(roomId, room); // 60s for creator to navigate to room.html
    socket.emit('room-created', { roomId, videoId });
    console.log(`[create-room] ${roomId} by ${displayName} | video: ${videoId}`);
  });

  // ── Join room ─────────────────────────────────────────────────────────────
  socket.on('join-room', ({ displayName, roomId }) => {
    const id = (roomId || '').trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('room-error', { message: `Room "${id}" not found.` });
      return;
    }

    // Cancel pending delete timer
    if (room._deleteTimer) {
      clearTimeout(room._deleteTimer);
      room._deleteTimer = null;
    }

    // Add user (skip if already in list — reconnect)
    if (!room.users.find(u => u.socketId === socket.id)) {
      room.users.push({ socketId: socket.id, displayName });
    }

    socket.join(id);

    // Assign host if none active
    if (!room.hostSocketId || !room.users.find(u => u.socketId === room.hostSocketId)) {
      room.hostSocketId = socket.id;
    }

    const isHost = socket.id === room.hostSocketId;

    // Compensate playback time for the duration since last sync
    let syncedState = { ...room.playbackState };
    if (syncedState.isPlaying) {
      const elapsed = (Date.now() - syncedState.lastSyncedAt) / 1000;
      syncedState = { ...syncedState, currentTime: syncedState.currentTime + elapsed };
    }

    socket.emit('room-joined', {
      roomId: id,
      videoId: room.videoId,
      playbackState: syncedState,
      isHost
    });

    socket.to(id).emit('user-joined', { displayName });
    broadcastUserList(id, room);

    // Start periodic sync for long movies once ≥2 users are in room
    if (room.users.length >= 2) {
      startSyncInterval(id, room);
    }

    console.log(`[join-room] ${id} ← ${displayName} (host:${isHost}) | ${room.users.length} users`);
  });

  // ── Playback sync ─────────────────────────────────────────────────────────
  socket.on('sync-playback', ({ roomId, action, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playbackState = { isPlaying: action === 'play', currentTime, lastSyncedAt: Date.now() };
    socket.to(roomId).emit('sync-playback', { action, currentTime });
    console.log(`[sync] ${roomId} | ${action} @ ${formatTime(currentTime)}`);
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const displayName = getUserName(room, socket.id);
    io.to(roomId).emit('chat-message', { displayName, message, timestamp: Date.now() });
  });

  // ── Typing ────────────────────────────────────────────────────────────────
  socket.on('typing', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.to(roomId).emit('typing', { displayName: getUserName(room, socket.id) });
  });

  // ── Change video ──────────────────────────────────────────────────────────
  socket.on('change-video', ({ roomId, videoUrl }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostSocketId) {
      socket.emit('room-error', { message: 'Only the host can change the video.' });
      return;
    }
    const videoId = extractVideoId(videoUrl);
    if (!videoId) { socket.emit('room-error', { message: 'Invalid YouTube URL.' }); return; }
    room.videoId = videoId;
    room.playbackState = { isPlaying: false, currentTime: 0, lastSyncedAt: Date.now() };
    io.to(roomId).emit('video-changed', { videoId });
    console.log(`[change-video] ${roomId} → ${videoId}`);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const found = getRoomForSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;
    const leaving = room.users.find(u => u.socketId === socket.id);
    room.users = room.users.filter(u => u.socketId !== socket.id);

    if (room.users.length === 0) {
      if (room._syncInterval) { clearInterval(room._syncInterval); room._syncInterval = null; }
      scheduleRoomDelete(roomId, room);
    } else {
      if (socket.id === room.hostSocketId) {
        room.hostSocketId = room.users[0].socketId;
        io.to(room.hostSocketId).emit('promoted-to-host');
      }
      if (leaving) io.to(roomId).emit('user-left', { displayName: leaving.displayName });
      broadcastUserList(roomId, room);
    }
    console.log(`[disconnect] ${socket.id} left ${roomId}`);
  });
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function getUserName(room, socketId) {
  const u = room.users.find(u => u.socketId === socketId);
  return u ? u.displayName : 'Unknown';
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬  WatchTogether running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/ping\n`);
});
