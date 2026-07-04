/* room.js — WatchTogether room page logic
   Handles: YouTube IFrame API, Socket.io sync, live chat, typing indicator,
            host controls, user list, reconnect on refresh
*/

// ─── Parse URL params ─────────────────────────────────────────────────────────
const params       = new URLSearchParams(window.location.search);
const ROOM_ID      = params.get('room') || '';
const DISPLAY_NAME = decodeURIComponent(params.get('name') || 'Anonymous');
const INITIAL_VID  = params.get('vid') || '';
let   initialState = null;
try { initialState = JSON.parse(decodeURIComponent(params.get('state') || 'null')); } catch(_) {}

// Redirect home if missing params
if (!ROOM_ID || !INITIAL_VID) {
  window.location.href = '/';
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const roomCodeDisplay  = document.getElementById('room-code-display');
const copyLinkBtn      = document.getElementById('copy-link-btn');
const copyLabel        = document.getElementById('copy-label');
const hostControls     = document.getElementById('host-controls');
const newVideoUrl      = document.getElementById('new-video-url');
const changeVideoBtn   = document.getElementById('change-video-btn');
const playerOverlay    = document.getElementById('player-overlay');
const overlayMsg       = document.getElementById('overlay-msg');
const videoTitle       = document.getElementById('video-title');
const userListEl       = document.getElementById('user-list');
const messagesList     = document.getElementById('messages-list');
const messagesWrapper  = document.getElementById('messages-wrapper');
const typingIndicator  = document.getElementById('typing-indicator');
const typingText       = document.getElementById('typing-text');
const chatInput        = document.getElementById('chat-input');
const sendBtn          = document.getElementById('send-btn');

// ─── State ────────────────────────────────────────────────────────────────────
let player          = null;
let isHost          = false;
let isSyncing       = false;   // Prevent echo: when we're applying an incoming sync
let syncTimeout     = null;
let typingTimer     = null;
let isTyping        = false;
let remoteTypers    = {};       // { name: timeoutId }
let currentVideoId  = INITIAL_VID;
let playerReady     = false;

// ─── Socket.io ───────────────────────────────────────────────────────────────
const socket = io();

// ─── Room code display & copy link ───────────────────────────────────────────
roomCodeDisplay.textContent = ROOM_ID;

copyLinkBtn.addEventListener('click', () => {
  const url = `${window.location.origin}/?room=${ROOM_ID}`;
  navigator.clipboard.writeText(url).then(() => {
    copyLabel.textContent = 'Copied!';
    copyLinkBtn.style.color = 'var(--green)';
    setTimeout(() => {
      copyLabel.textContent = 'Copy Link';
      copyLinkBtn.style.color = '';
    }, 2000);
  });
});

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(type, text) {
  statusDot.className = 'status-dot' + (type ? ` ${type}` : '');
  statusText.textContent = text;
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
// Called automatically by the YouTube API script when ready
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('yt-player', {
    videoId: currentVideoId,
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      enablejsapi: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
    }
  });
};

function onPlayerReady(event) {
  playerReady = true;
  overlayMsg.textContent = 'Waiting for your friend to join…';

  // If we joined an existing session, seek to the right time
  if (initialState) {
    let seekTo = initialState.currentTime || 0;
    if (initialState.isPlaying) {
      // Compensate for time elapsed since last sync
      const elapsed = (Date.now() - (initialState.lastSyncedAt || Date.now())) / 1000;
      seekTo = Math.max(0, seekTo + elapsed);
    }
    applySyncSilently('seek', seekTo);
    if (initialState.isPlaying) {
      setTimeout(() => applySyncSilently('play', seekTo), 300);
    }
  }

  // Try to get video title
  try {
    const data = event.target.getVideoData();
    if (data && data.title) videoTitle.textContent = data.title;
  } catch(_) {}

  // Re-join the room via socket now that we're in the room page
  socket.emit('join-room', { displayName: DISPLAY_NAME, roomId: ROOM_ID });
}

function onPlayerStateChange(event) {
  if (!playerReady || isSyncing) return;

  const stateMap = { 1: 'play', 2: 'pause', 3: 'seeking' };
  const state    = event.data;
  const time     = player.getCurrentTime();

  if (state === YT.PlayerState.PLAYING) {
    emitSync('play', time);
  } else if (state === YT.PlayerState.PAUSED) {
    emitSync('pause', time);
  } else if (state === YT.PlayerState.BUFFERING) {
    // Buffering often means a seek just happened
    emitSync('seek', time);
  }
}

function emitSync(action, currentTime) {
  socket.emit('sync-playback', { roomId: ROOM_ID, action, currentTime });
}

// Apply an incoming sync without triggering another outgoing event
function applySyncSilently(action, currentTime) {
  isSyncing = true;
  clearTimeout(syncTimeout);

  if (!player || !playerReady) {
    isSyncing = false;
    return;
  }

  try {
    if (action === 'seek' || action === 'play') {
      const diff = Math.abs(player.getCurrentTime() - currentTime);
      if (diff > 1.5) player.seekTo(currentTime, true); // only seek if off by > 1.5s
    }
    if (action === 'play')  player.playVideo();
    if (action === 'pause') player.pauseVideo();
    if (action === 'seek')  { /* seek handled above */ }
  } catch(err) {
    console.warn('[sync] player error:', err);
  }

  syncTimeout = setTimeout(() => { isSyncing = false; }, 600);
}

// ─── Socket events — playback sync ───────────────────────────────────────────
socket.on('sync-playback', ({ action, currentTime, senderName }) => {
  applySyncSilently(action, currentTime);
});

// ─── Socket events — room ─────────────────────────────────────────────────────
socket.on('connect', () => {
  setStatus('connected', 'Connected');
});

socket.on('disconnect', () => {
  setStatus('error', 'Disconnected — reconnecting…');
});

socket.on('reconnect', () => {
  setStatus('connected', 'Reconnected');
  socket.emit('join-room', { displayName: DISPLAY_NAME, roomId: ROOM_ID });
});

// Received when we join an existing room (on page-load join handled in onPlayerReady)
socket.on('room-joined', ({ isHost: hostFlag, playbackState }) => {
  if (hostFlag) becomeHost();
});

socket.on('room-error', ({ message }) => {
  overlayMsg.textContent = `⚠ ${message}`;
  playerOverlay.classList.remove('fade-out');
  addSystemMessage(message);
  setStatus('error', 'Error');
});

socket.on('user-list', ({ users, hostSocketId }) => {
  renderUserList(users);
  // Hide overlay once at least one other person is in the room
  if (users.length >= 2) {
    playerOverlay.classList.add('fade-out');
    setTimeout(() => { playerOverlay.style.display = 'none'; }, 400);
  }
});

socket.on('user-joined', ({ displayName }) => {
  addSystemMessage(`${displayName} joined the room 🎉`);
});

socket.on('user-left', ({ displayName }) => {
  addSystemMessage(`${displayName} left the room`);
});

socket.on('promoted-to-host', () => {
  becomeHost();
  addSystemMessage('You are now the host 👑');
});

socket.on('video-changed', ({ videoId }) => {
  currentVideoId = videoId;
  if (player && playerReady) {
    isSyncing = true;
    player.loadVideoById(videoId);
    setTimeout(() => { isSyncing = false; }, 800);
  }
  addSystemMessage('Host changed the video.');
});

// ─── Host controls ────────────────────────────────────────────────────────────
function becomeHost() {
  isHost = true;
  hostControls.classList.remove('hidden');
}

changeVideoBtn.addEventListener('click', () => {
  const url = newVideoUrl.value.trim();
  if (!url) return;
  socket.emit('change-video', { roomId: ROOM_ID, videoUrl: url });
  newVideoUrl.value = '';
});

newVideoUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') changeVideoBtn.click();
});

// ─── User list rendering ──────────────────────────────────────────────────────
function renderUserList(users) {
  userListEl.innerHTML = '';
  users.forEach(({ displayName, isHost: uIsHost }) => {
    const li = document.createElement('li');
    li.className = 'user-item';

    const initials = displayName.slice(0, 2).toUpperCase();
    li.innerHTML = `
      <div class="user-avatar">${initials}</div>
      <span class="user-name">${escapeHtml(displayName)}</span>
      ${uIsHost ? '<span class="user-host-tag">HOST</span>' : ''}
      <span class="user-online-dot"></span>
    `;
    userListEl.appendChild(li);
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { roomId: ROOM_ID, message: text });
  chatInput.value = '';
  stopTyping();
}

socket.on('chat-message', ({ displayName, message, timestamp }) => {
  const isOwn = displayName === DISPLAY_NAME;
  addChatMessage(displayName, message, timestamp, isOwn);
});

function addChatMessage(sender, message, timestamp, isOwn) {
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const li = document.createElement('li');
  li.className = `msg-item ${isOwn ? 'own' : 'other'}`;
  li.innerHTML = `
    <div class="msg-meta">
      <span class="msg-sender">${isOwn ? 'You' : escapeHtml(sender)}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-bubble">${escapeHtml(message)}</div>
  `;
  messagesList.appendChild(li);
  scrollToBottom();
}

function addSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'msg-item system';
  li.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  messagesList.appendChild(li);
  scrollToBottom();
}

function scrollToBottom() {
  messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
chatInput.addEventListener('input', () => {
  if (!isTyping && chatInput.value.trim()) {
    isTyping = true;
    socket.emit('typing', { roomId: ROOM_ID });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 2500);
});

function stopTyping() {
  isTyping = false;
  clearTimeout(typingTimer);
}

socket.on('typing', ({ displayName }) => {
  if (displayName === DISPLAY_NAME) return;

  // Clear any existing hide timer for this typer
  if (remoteTypers[displayName]) clearTimeout(remoteTypers[displayName]);

  updateTypingDisplay(displayName);

  remoteTypers[displayName] = setTimeout(() => {
    delete remoteTypers[displayName];
    updateTypingDisplay(null);
  }, 3000);
});

function updateTypingDisplay(name) {
  const names = Object.keys(remoteTypers);
  if (names.length === 0) {
    typingIndicator.classList.add('hidden');
    return;
  }
  typingIndicator.classList.remove('hidden');
  const who = names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} other${names.length > 2 ? 's' : ''}`;
  typingText.textContent = `${who} is typing`;
}

// ─── Security helper ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Set initial status ───────────────────────────────────────────────────────
setStatus('', 'Connecting…');
