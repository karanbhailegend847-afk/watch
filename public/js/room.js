/* room.js — WatchTogether room page (with long-movie sync & reconnect support)
   KEY FIX: join-room is emitted on socket CONNECT (not inside onPlayerReady),
   so the room join is instant and doesn't depend on YouTube loading.
*/

// ─── Parse URL params ─────────────────────────────────────────────────────────
const params       = new URLSearchParams(window.location.search);
const ROOM_ID      = (params.get('room') || '').toUpperCase();
const DISPLAY_NAME = decodeURIComponent(params.get('name') || 'Anonymous');
const INITIAL_VID  = params.get('vid') || '';

// Redirect home if missing critical params
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
let player            = null;
let playerReady       = false;
let isHost            = false;
let isSyncing         = false;
let syncTimeout       = null;
let isTyping          = false;
let typingTimer       = null;
let remoteTypers      = {};
let currentVideoId    = INITIAL_VID;
let pendingState      = null; // Playback state received before player was ready

// ─── Socket setup ─────────────────────────────────────────────────────────────
const socket = io();

// ─── Room UI setup ────────────────────────────────────────────────────────────
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
  }).catch(() => {
    // Fallback for browsers that block clipboard
    prompt('Copy this invite link:', `${window.location.origin}/?room=${ROOM_ID}`);
  });
});

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(type, text) {
  statusDot.className = 'status-dot' + (type ? ` ${type}` : '');
  statusText.textContent = text;
}

setStatus('', 'Connecting…');

// ─── Socket events — connection lifecycle ─────────────────────────────────────

socket.on('connect', () => {
  setStatus('connected', 'Connected');
  overlayMsg.textContent = 'Joining room…';

  // ★ KEY FIX: Join the room immediately on connect — don't wait for YouTube
  socket.emit('join-room', { displayName: DISPLAY_NAME, roomId: ROOM_ID });
});

socket.on('disconnect', () => {
  setStatus('error', 'Disconnected — reconnecting…');
});

socket.on('connect_error', () => {
  setStatus('error', 'Connection failed');
  overlayMsg.textContent = '⚠ Cannot reach server. Retrying…';
});

// On reconnect — rejoin the room and resync video position
socket.on('reconnect', () => {
  setStatus('connected', 'Reconnected');
  overlayMsg.textContent = 'Rejoining room…';
  playerOverlay.style.display = 'flex';
  playerOverlay.style.opacity = '1';
  socket.emit('join-room', { displayName: DISPLAY_NAME, roomId: ROOM_ID });
});

// Heartbeat sync — server sends authoritative time every 30s during playback
// Corrects drift on long movies without interrupting playback
socket.on('heartbeat-sync', ({ currentTime, isPlaying }) => {
  if (!player || !playerReady) return;
  const playerTime = player.getCurrentTime();
  const drift = Math.abs(playerTime - currentTime);
  // Only correct if drifted more than 3 seconds (avoids jitter on short seeks)
  if (drift > 3) {
    console.log(`[heartbeat] correcting drift of ${drift.toFixed(1)}s`);
    applySyncSilently(isPlaying ? 'play' : 'pause', currentTime);
  }
});

// ─── Socket events — room ─────────────────────────────────────────────────────

socket.on('room-joined', ({ isHost: hostFlag, playbackState }) => {
  if (hostFlag) becomeHost();

  // Store playback state — will be applied once the player is ready
  if (playbackState) {
    pendingState = playbackState;
    if (playerReady) applyState(pendingState);
  }

  overlayMsg.textContent = 'Waiting for your friend to join…';
});

socket.on('room-error', ({ message }) => {
  setStatus('error', 'Error');
  overlayMsg.textContent = `⚠ ${message}`;
  addSystemMessage(message);
});

socket.on('user-list', ({ users }) => {
  renderUserList(users);

  if (users.length >= 2) {
    // Both users are in the room — hide the overlay
    playerOverlay.style.transition = 'opacity 0.4s';
    playerOverlay.style.opacity = '0';
    setTimeout(() => { playerOverlay.style.display = 'none'; }, 400);
  } else {
    // Back to one user (friend left) — show overlay again
    playerOverlay.style.display = 'flex';
    playerOverlay.style.opacity = '1';
    overlayMsg.textContent = 'Waiting for your friend to join…';
  }
});

socket.on('user-joined', ({ displayName }) => {
  addSystemMessage(`${displayName} joined 🎉`);
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
    setTimeout(() => { isSyncing = false; }, 1000);
  }
  addSystemMessage('Host changed the video.');
});

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
// Called automatically by the YT script tag when API is ready
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

  // Apply any playback state that arrived before the player was ready
  if (pendingState) {
    applyState(pendingState);
    pendingState = null;
  }

  // Try to display the video title
  try {
    const data = event.target.getVideoData();
    if (data && data.title) videoTitle.textContent = data.title;
  } catch (_) {}
}

function onPlayerStateChange(event) {
  if (!playerReady || isSyncing) return;

  const time = player.getCurrentTime();

  if (event.data === YT.PlayerState.PLAYING) {
    emitSync('play', time);
  } else if (event.data === YT.PlayerState.PAUSED) {
    emitSync('pause', time);
  } else if (event.data === YT.PlayerState.BUFFERING) {
    // Buffering almost always means a seek just happened
    emitSync('seek', time);
  }
}

function emitSync(action, currentTime) {
  socket.emit('sync-playback', { roomId: ROOM_ID, action, currentTime });
}

// Apply incoming sync without triggering another outgoing event (echo prevention)
function applySyncSilently(action, currentTime) {
  if (!player || !playerReady) return;
  isSyncing = true;
  clearTimeout(syncTimeout);

  try {
    if (action === 'play' || action === 'seek') {
      const diff = Math.abs(player.getCurrentTime() - currentTime);
      if (diff > 1.5) player.seekTo(currentTime, true);
    }
    if (action === 'play')  player.playVideo();
    if (action === 'pause') { player.seekTo(currentTime, true); player.pauseVideo(); }
  } catch (err) {
    console.warn('[sync] player error:', err);
  }

  syncTimeout = setTimeout(() => { isSyncing = false; }, 700);
}

// Apply a stored playback state (for late joiners / reconnects)
function applyState(state) {
  if (!state || !player || !playerReady) return;
  isSyncing = true;

  let seekTo = state.currentTime || 0;
  if (state.isPlaying) {
    const elapsed = (Date.now() - (state.lastSyncedAt || Date.now())) / 1000;
    seekTo = Math.max(0, seekTo + elapsed);
  }

  try {
    player.seekTo(seekTo, true);
    if (state.isPlaying) {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  } catch (err) {
    console.warn('[applyState] error:', err);
  }

  setTimeout(() => { isSyncing = false; }, 800);
}

// ─── Socket events — playback sync ────────────────────────────────────────────
socket.on('sync-playback', ({ action, currentTime }) => {
  applySyncSilently(action, currentTime);
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

// ─── User list ────────────────────────────────────────────────────────────────
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
  if (remoteTypers[displayName]) clearTimeout(remoteTypers[displayName]);
  updateTypingDisplay();
  remoteTypers[displayName] = setTimeout(() => {
    delete remoteTypers[displayName];
    updateTypingDisplay();
  }, 3000);
});

function updateTypingDisplay() {
  const names = Object.keys(remoteTypers);
  if (names.length === 0) {
    typingIndicator.classList.add('hidden');
    return;
  }
  typingIndicator.classList.remove('hidden');
  const who = names.length === 1
    ? names[0]
    : `${names[0]} and ${names.length - 1} other${names.length > 2 ? 's' : ''}`;
  typingText.textContent = `${who} is typing`;
}

// ─── XSS protection ───────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
