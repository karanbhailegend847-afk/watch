# WatchTogether 🎬

> Watch YouTube videos in perfect sync with a friend — live chat included.

---

## Features

- 🔗 **Shareable room codes** — paste a YouTube URL, get a 6-char room code
- ▶️ **Real-time video sync** — play/pause/seek synced within ~1 second via Socket.io
- 💬 **Live chat** — messages with sender names and timestamps
- ✍️ **Typing indicator** — animated dots when the other person is typing
- 👑 **Host controls** — only the room creator can change the video URL
- 🔄 **Reconnect support** — refreshing the page rejoins the room at the right timestamp
- 🌙 **Dark glassmorphism UI** — looks great out of the box

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) v16 or newer

### 1 — Install

```bash
cd WatchTogether
npm install
```

### 2 — Start

```bash
npm start
```

The server starts at **http://localhost:3000**

> **Dev mode** (auto-restarts on file changes):
> ```bash
> npm run dev
> ```

### 3 — Test with two tabs

1. Open **http://localhost:3000** in Tab 1  
2. Enter your name, paste a YouTube URL → click **Create Room**  
3. Copy the room code shown at the top  
4. Open **http://localhost:3000** in Tab 2 (or another browser)  
5. Enter a name, paste the room code → click **Join Room**  
6. Play/pause/seek in either tab — the other mirrors it instantly ✨

---

## Project Structure

```
WatchTogether/
├── server.js           # Express + Socket.io backend
├── package.json
├── public/             # Static frontend (served by Express)
│   ├── index.html      # Home / lobby page
│   ├── room.html       # Watch party room page
│   ├── css/
│   │   └── style.css   # All styles (dark glassmorphism)
│   └── js/
│       ├── home.js     # Room create / join logic
│       └── room.js     # YouTube sync + chat
└── README.md
```

---

## How It Works

### Video Sync
The YouTube IFrame Player API fires `onStateChange` events whenever the video plays, pauses, or buffers (seek). Each event emits a `sync-playback` Socket.io message to the server, which relays it to the other user in the room.

An `isSyncing` flag prevents "echo loops" — when a user receives a sync event and applies it to their player, that action does not re-emit another sync event.

### Room Management
Rooms live in a server-side `Map` (in-memory). Each room stores:
- The YouTube video ID
- Current playback state (isPlaying, currentTime, lastSyncedAt)
- Connected users with socket IDs
- Who the host is

If the host disconnects, the next user in the list is automatically promoted to host.

### Reconnect
Room ID, display name, and video ID are stored in the URL query string. Refreshing the page uses these to rejoin the room, and the server sends back the last known playback state so the video seeks to the right position.

---

## Environment

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |

```bash
PORT=8080 npm start
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.io v4 |
| Frontend | Plain HTML/CSS/JS |
| Video | YouTube IFrame Player API |
| Styling | Vanilla CSS (glassmorphism) |
| Font | Inter (Google Fonts) |
