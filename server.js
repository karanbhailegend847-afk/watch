const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ────────────────────────────────────────────────────
// rooms: Map<roomId, RoomObject>
// RoomObject = {
//   roomId, hostSocketId, videoId,
//   playbackState: { isPlaying, currentTime, lastSyncedAt },
//   users: [{ socketId, displayName }]
// }
const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomId() {
  return uuidv4().split('-')[0].toUpperCase(); // e.g. "A3F7E2"
}

function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  // Already a plain video ID (11 chars, no slashes)
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId.trim())) return urlOrId.trim();

  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = urlOrId.match(re);
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
    users: room.users.map(u => ({ displayName: u.displayName, isHost: u.socketId === room.hostSocketId })),
    hostSocketId: room.hostSocketId
  });
}

// ─── Socket.io events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Create a new room ──────────────────────────────────────────────────────
  socket.on('create-room', ({ displayName, videoUrl }) => {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      socket.emit('room-error', { message: 'Invalid YouTube URL or video ID.' });
      return;
    }

    const roomId = generateRoomId();
    const room = {
      roomId,
      hostSocketId: socket.id,
      videoId,
      playbackState: { isPlaying: false, currentTime: 0, lastSyncedAt: Date.now() },
      users: [{ socketId: socket.id, displayName }]
    };
    rooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('room-created', { roomId, videoId, isHost: true });
    broadcastUserList(roomId, room);
    console.log(`[create-room] ${roomId} by ${displayName} | video: ${videoId}`);
  });

  // ── Join an existing room ──────────────────────────────────────────────────
  socket.on('join-room', ({ displayName, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', { message: `Room "${roomId}" not found. Check the code and try again.` });
      return;
    }

    // Prevent duplicate socketId (e.g. rapid reconnect)
    if (!room.users.find(u => u.socketId === socket.id)) {
      room.users.push({ socketId: socket.id, displayName });
    }

    socket.join(roomId);

    const isHost = socket.id === room.hostSocketId;

    // Send current room state to the joining user
    socket.emit('room-joined', {
      roomId,
      videoId: room.videoId,
      playbackState: room.playbackState,
      isHost
    });

    // Notify others someone joined
    socket.to(roomId).emit('user-joined', { displayName });

    broadcastUserList(roomId, room);
    console.log(`[join-room] ${roomId} joined by ${displayName}`);
  });

  // ── Playback sync (play / pause / seek) ───────────────────────────────────
  socket.on('sync-playback', ({ roomId, action, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Update stored playback state
    room.playbackState = {
      isPlaying: action === 'play',
      currentTime,
      lastSyncedAt: Date.now()
    };

    // Relay to everyone else in the room
    socket.to(roomId).emit('sync-playback', { action, currentTime, senderName: getUserName(room, socket.id) });
    console.log(`[sync] ${roomId} | ${action} @ ${currentTime.toFixed(1)}s`);
  });

  // ── Chat message ──────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const displayName = getUserName(room, socket.id);
    const payload = { displayName, message, timestamp: Date.now() };
    // Send to ALL including sender (so sender sees their own message confirmed)
    io.to(roomId).emit('chat-message', payload);
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
      rooms.delete(roomId);
      console.log(`[room-closed] ${roomId} (empty)`);
      return;
    }

    // Promote next user if host left
    if (socket.id === room.hostSocketId) {
      room.hostSocketId = room.users[0].socketId;
      io.to(room.hostSocketId).emit('promoted-to-host');
    }

    if (leaving) {
      io.to(roomId).emit('user-left', { displayName: leaving.displayName });
    }
    broadcastUserList(roomId, room);
    console.log(`[disconnect] ${socket.id} left ${roomId}`);
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
