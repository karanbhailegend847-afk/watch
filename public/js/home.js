/* home.js — WatchTogether home/lobby page logic */

const socket = io();

// ─── DOM ─────────────────────────────────────────────────────────────────────
const createBtn    = document.getElementById('create-btn');
const joinBtn      = document.getElementById('join-btn');
const createName   = document.getElementById('create-name');
const videoUrl     = document.getElementById('video-url');
const joinName     = document.getElementById('join-name');
const roomCode     = document.getElementById('room-code');
const createError  = document.getElementById('create-error');
const joinError    = document.getElementById('join-error');
const loadOverlay  = document.getElementById('loading-overlay');
const loadingMsg   = document.getElementById('loading-msg');

// ─── Pre-fill name from localStorage ─────────────────────────────────────────
const savedName = localStorage.getItem('wt_display_name');
if (savedName) {
  createName.value = savedName;
  joinName.value = savedName;
}

// Pre-fill room code if URL has ?room=XXX (e.g. shared link)
const urlParams = new URLSearchParams(window.location.search);
const prefilledRoom = urlParams.get('room');
if (prefilledRoom) {
  roomCode.value = prefilledRoom.toUpperCase();
  joinName.focus();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function showLoading(msg) {
  loadingMsg.textContent = msg;
  loadOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadOverlay.classList.add('hidden');
}

function saveName(name) {
  localStorage.setItem('wt_display_name', name.trim());
}

// ─── Create Room ─────────────────────────────────────────────────────────────
createBtn.addEventListener('click', () => {
  const name = createName.value.trim();
  const url  = videoUrl.value.trim();

  if (!name) { showError(createError, 'Please enter your display name.'); return; }
  if (!url)  { showError(createError, 'Please enter a YouTube URL or video ID.'); return; }

  saveName(name);
  showLoading('Creating your room…');

  socket.emit('create-room', { displayName: name, videoUrl: url });
});

socket.on('room-created', ({ roomId, videoId }) => {
  hideLoading();
  const name = createName.value.trim();
  // Navigate to the room page
  window.location.href = `/room.html?room=${roomId}&name=${encodeURIComponent(name)}&vid=${videoId}`;
});

// ─── Join Room ────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', doJoin);
roomCode.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = joinName.value.trim();
  const code = roomCode.value.trim().toUpperCase();

  if (!name) { showError(joinError, 'Please enter your display name.'); return; }
  if (!code) { showError(joinError, 'Please enter a room code.'); return; }

  saveName(name);
  showLoading(`Joining room ${code}…`);

  socket.emit('join-room', { displayName: name, roomId: code });
}

socket.on('room-joined', ({ roomId, videoId, playbackState }) => {
  hideLoading();
  const name = joinName.value.trim();
  const state = encodeURIComponent(JSON.stringify(playbackState));
  window.location.href = `/room.html?room=${roomId}&name=${encodeURIComponent(name)}&vid=${videoId}&state=${state}`;
});

// ─── Errors ───────────────────────────────────────────────────────────────────
socket.on('room-error', ({ message }) => {
  hideLoading();
  // Show error in the most recently active card
  const activeCreate = document.activeElement.closest('#create-card');
  if (activeCreate) showError(createError, message);
  else showError(joinError, message);
});

// Enter key shortcuts
createName.addEventListener('keydown', e => { if (e.key === 'Enter') videoUrl.focus(); });
videoUrl.addEventListener('keydown',   e => { if (e.key === 'Enter') createBtn.click(); });
joinName.addEventListener('keydown',   e => { if (e.key === 'Enter') roomCode.focus(); });
