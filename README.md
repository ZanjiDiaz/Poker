# 🃏 SEVENS — Pixel Multiplayer Card Game

Balatro-inspired pixel-art card game. Real-time multiplayer via WebSockets.

## ✨ What Changed (v2)
- **No End Turn** — draw freely at any time, no turn order
- **Opponent card counts visible** — see exactly how many active/done cards each player has
- **"Done" explained** — clicking a card marks it as played/used (turns gray). Click again to undo
- **Session persistence** — reloading keeps you in your room automatically
- **Balatro-style UI** — pixel fonts, scanlines, neon glow, chunky cards, CRT vibes

## 🚀 Run Locally

```bash
npm install
npm start
# → http://localhost:3000
```

## 🌐 Host for Friends (Same WiFi)
1. `npm start`
2. Find your IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
3. Share `http://YOUR_IP:3000`

## ☁️ Free Cloud Deploy

### Render.com (recommended)
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Build: `npm install` · Start: `npm start`
4. Get a public URL!

### Railway.app
1. Push to GitHub → railway.app → deploy from GitHub

## 🎮 How to Play
1. Host clicks **HOST NEW GAME**, shares the 5-letter code
2. Friends join with the code (min 2, max 6 players)
3. Host clicks **START GAME** — everyone gets **7 cards**
4. **DRAW** anytime by clicking the deck
5. **Click any card** → marks it as DONE (grayed out = played/used)
6. Click a DONE card again → moves it back to active
7. When you've won → **DECLARE WIN**

## 📁 Files
```
sevens/
├── server.js          WebSocket + Express server
├── package.json
├── public/
│   └── index.html     Full pixel game client
└── README.md
```
