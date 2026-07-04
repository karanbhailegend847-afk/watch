const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Allow both WebSocket and long-polling fallback
  transports: ['websocket', 'polling']
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ────────────────────────────────────────────────────
// RoomObject = {
//   roomId, hostSocketId, videoId, creatorName,
//   playbackState: { isPlaying, currentTime, lastSyncedAt },
//   users: [{ socketId, displayName }],
//   _deleteTimer: <timeout handle>   ← grace period on empty room
// }
const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomId() {
  return uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();
}

function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();
  // Already a plain video ID (11 chars, alphanumeric + - _)
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

// Start a 60-second grace timer before deleting an empty room.
// Cancelled if someone joins before it fires (handles page-navigation reconnects).
function scheduleRoomDelete(roomId, room) {
  if (room._deleteTimer) return; // Already scheduled
  room._deleteTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.users.length === 0) {
      rooms.delete(roomId);
      console.log(`[room-expired] ${roomId}`);
    }
  }, 60_000);
  console.log(`[room-grace] ${roomId} will expire in 60s if no one joins`);
}

// ─── Socket.io events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Validate room without joining (used by home.js join flow) ─────────────
  socket.on('check-room', ({ roomId }) => {
    const id = (roomId || '').trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('room-error', { message: `Room "${id}" not found. Check the code and try again.` });
      return;
    }
    socket.emit('room-checked', { roomId: id, videoId: room.videoId });
  });

  // ── Create a new room ──────────────────────────────────────────────────────
  // Note: creator is NOT added to users here — they will join properly from room.html
  socket.on('create-room', ({ displayName, videoUrl }) => {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      socket.emit('room-error', { message: 'Invalid YouTube URL or video ID.' });
      return;
    }

    const roomId = generateRoomId();
    const room = {
      roomId,
      hostSocketId: null,       // Assigned when they join from room.html
      creatorName: displayName, // Remember so we can grant host on first join
      videoId,
      playbackState: { isPlaying: false, currentTime: 0, lastSyncedAt: Date.now() },
      users: [],
      _deleteTimer: null
    };
    rooms.set(roomId, room);

    // Give 60s for the creator to navigate to room.html and join
    scheduleRoomDelete(roomId, room);

    socket.emit('room-created', { roomId, videoId });
    console.log(`[create-room] ${roomId} by ${displayName} | video: ${videoId}`);
  });

  // ── Join an existing room ──────────────────────────────────────────────────
  // Called from room.html as soon as socket connects (not after YouTube loads)
  socket.on('join-room', ({ displayName, roomId }) => {
    const id = (roomId || '').trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('room-error', { message: `Room "${id}" not found.` });
      return;
    }

    // Cancel any pending delete timer — someone is here!
    if (room._deleteTimer) {
      clearTimeout(room._deleteTimer);
      room._deleteTimer = null;
    }

    // Prevent duplicate socketId (rapid reconnect)
    if (!room.users.find(u => u.socketId === socket.id)) {
      room.users.push({ socketId: socket.id, displayName });
    }

    socket.join(id);

    // If no active host, make this socket the host
    // (handles creator reconnect after page navigation)
    if (!room.hostSocketId || !room.users.find(u => u.socketId === room.hostSocketId)) {
      room.hostSocketId = socket.id;
    }

    const isHost = socket.id === room.hostSocketId;

    // Send full room state to joiner
    socket.emit('room-joined', {
      roomId: id,
      videoId: room.videoId,
      playbackState: room.playbackState,
      isHost
    });

    // Notify others
    socket.to(id).emit('user-joined', { displayName });
    broadcastUserList(id, room);
    console.log(`[join-room] ${id} ← ${displayName} (host:${isHost})`);
  });

  // ── Playback sync (play / pause / seek) ───────────────────────────────────
  socket.on('sync-playback', ({ roomId, action, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.playbackState = {
      isPlaying: action === 'play',
      currentTime,
      lastSyncedAt: Date.now()
    };

    socket.to(roomId).emit('sync-playback', {
      action,
      currentTime,
      senderName: getUserName(room, socket.id)
    });
    console.log(`[sync] ${roomId} | ${action} @ ${currentTime.toFixed(1)}s`);
  });

  // ── Chat message ──────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const displayName = getUserName(room, socket.id);
    io.to(roomId).emit('chat-message', { displayName, message, timestamp: Date.now() });
  });

  // ── Typing indicator ──────────────────────────────────────────────────────
  socket.on('typing', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const displayName = getUserName(room, socket.id);
    socket.to(roomId).emit('typing', { displayName });
  });

  // ── Host changes video URL ────────────────────────────────────────────────
  socket.on('change-video', ({ roomId, videoUrl }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostSocketId) {
      socket.emit('room-error', { message: 'Only the host can change the video.' });
      return;
    }
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      socket.emit('room-error', { message: 'Invalid YouTube URL.' });
      return;
    }
    room.videoId = videoId;
    room.playbackState = { isPlaying: false, currentTime: 0, lastSyncedAt: Date.now() };
    io.to(roomId).emit('video-changed', { videoId });
    console.log(`[change-video] ${roomId} → ${videoId}`);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const found = getRoomForSocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    const leaving = room.users.find(u => u.socketId === socket.id);
    room.users = room.users.filter(u => u.socketId !== socket.id);

    if (room.users.length === 0) {
      // Start grace period — don't delete immediately (page navigation takes ~1-2s)
      scheduleRoomDelete(roomId, room);
    } else {
      // Promote a new host if current host left
      if (socket.id === room.hostSocketId) {
        room.hostSocketId = room.users[0].socketId;
        io.to(room.hostSocketId).emit('promoted-to-host');
      }
      if (leaving) {
        io.to(roomId).emit('user-left', { displayName: leaving.displayName });
      }
      broadcastUserList(roomId, room);
    }

    console.log(`[disconnect] ${socket.id} left room ${roomId}`);
  });
});

// ─── Utility ──────────────────────────────────────────────────────────────────
function getUserName(room, socketId) {
  const user = room.users.find(u => u.socketId === socketId);
  return user ? user.displayName : 'Unknown';
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬  WatchTogether running at http://localhost:${PORT}\n`);
});
