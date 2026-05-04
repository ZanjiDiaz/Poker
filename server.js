const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
// ws -> { playerId, roomId, playerName }
const clients = new Map();
// playerId -> ws (for reconnect)
const playerSockets = new Map();

function createDeck() {
  const suits = ['S','H','D','C']; // spades hearts diamonds clubs
  const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  for (const suit of suits)
    for (const value of values)
      deck.push({ suit, value, id: `${value}${suit}` });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getRoomState(room, forPlayerId) {
  return {
    code: room.code,
    gameStarted: room.gameStarted,
    deckCount: room.deck.length,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      doneCount: p.doneCards.length,
      connected: p.connected,
      isYou: p.id === forPlayerId,
      hand: p.id === forPlayerId ? p.hand : null,
      doneCards: p.id === forPlayerId ? p.doneCards : null,
    })),
    hostId: room.hostId,
  };
}

function broadcastAll(room, messageFactory) {
  for (const [ws, info] of clients.entries()) {
    if (info.roomId === room.code && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(messageFactory(info.playerId)));
    }
  }
}

function broadcast(room, message, excludeId = null) {
  for (const [ws, info] of clients.entries()) {
    if (info.roomId === room.code && info.playerId !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function sendTo(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(message));
}

wss.on('connection', (ws) => {
  const connId = uuidv4();
  clients.set(ws, { playerId: connId, roomId: null, playerName: '' });

  sendTo(ws, { type: 'connected', playerId: connId });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;

    // --- RECONNECT ---
    if (msg.type === 'reconnect') {
      const { savedPlayerId, savedRoomCode } = msg;
      const room = savedRoomCode && rooms.get(savedRoomCode);
      if (!room) { sendTo(ws, { type: 'reconnect_failed' }); return; }
      const player = room.players.find(p => p.id === savedPlayerId);
      if (!player) { sendTo(ws, { type: 'reconnect_failed' }); return; }

      // Detach old socket
      const oldWs = playerSockets.get(savedPlayerId);
      if (oldWs && oldWs !== ws) {
        clients.delete(oldWs);
      }

      // Update info
      info.playerId = savedPlayerId;
      info.roomId = savedRoomCode;
      info.playerName = player.name;
      player.connected = true;
      playerSockets.set(savedPlayerId, ws);

      sendTo(ws, {
        type: 'reconnected',
        playerId: savedPlayerId,
        state: getRoomState(room, savedPlayerId),
        gameStarted: room.gameStarted
      });
      broadcast(room, { type: 'sys', text: `${player.name} reconnected` }, savedPlayerId);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      return;
    }

    // --- CREATE ROOM ---
    if (msg.type === 'create_room') {
      const code = Math.random().toString(36).substring(2,7).toUpperCase();
      const name = (msg.name||'Host').substring(0,18);
      info.playerName = name;
      info.roomId = code;
      info.playerId = connId;
      playerSockets.set(connId, ws);

      const room = {
        code, hostId: connId,
        players: [{ id: connId, name, hand: [], doneCards: [], connected: true }],
        deck: [], gameStarted: false, createdAt: Date.now()
      };
      rooms.set(code, room);
      sendTo(ws, { type: 'room_created', code, playerId: connId, state: getRoomState(room, connId) });
      return;
    }

    // --- JOIN ROOM ---
    if (msg.type === 'join_room') {
      const code = (msg.code||'').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
      if (room.gameStarted) { sendTo(ws, { type: 'error', message: 'Game already in progress' }); return; }
      if (room.players.length >= 6) { sendTo(ws, { type: 'error', message: 'Room full (max 6)' }); return; }

      const name = (msg.name||'Player').substring(0,18);
      info.playerName = name;
      info.roomId = code;
      playerSockets.set(connId, ws);
      room.players.push({ id: connId, name, hand: [], doneCards: [], connected: true });

      sendTo(ws, { type: 'room_joined', code, playerId: connId, state: getRoomState(room, connId) });
      broadcast(room, { type: 'sys', text: `${name} joined` }, connId);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      return;
    }

    const room = info.roomId && rooms.get(info.roomId);
    if (!room) return;

    // --- START GAME ---
    if (msg.type === 'start_game') {
      if (room.hostId !== info.playerId) return;
      if (room.players.length < 2) { sendTo(ws, { type: 'error', message: 'Need at least 2 players' }); return; }
      room.deck = createDeck();
      for (const p of room.players) { p.hand = room.deck.splice(0,7); p.doneCards = []; }
      room.gameStarted = true;
      broadcastAll(room, pid => ({ type: 'game_started', state: getRoomState(room, pid) }));
      broadcastAll(room, () => ({ type: 'sys', text: 'Game started! Each player has 7 cards.' }));
      return;
    }

    // --- DRAW CARD (auto turn pass removed — free draw anytime) ---
    if (msg.type === 'draw_card') {
      if (!room.gameStarted) return;
      if (room.deck.length === 0) { sendTo(ws, { type: 'error', message: 'Deck is empty!' }); return; }
      const player = room.players.find(p => p.id === info.playerId);
      if (!player) return;
      const card = room.deck.splice(0,1)[0];
      player.hand.push(card);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      broadcast(room, { type: 'sys', text: `${player.name} drew a card` }, info.playerId);
      return;
    }

    // --- TOGGLE CARD DONE ---
    if (msg.type === 'toggle_done') {
      if (!room.gameStarted) return;
      const player = room.players.find(p => p.id === info.playerId);
      if (!player) return;
      const { cardId } = msg;
      const inHand = player.hand.findIndex(c => c.id === cardId);
      const inDone = player.doneCards.findIndex(c => c.id === cardId);
      if (inHand !== -1) {
        const [c] = player.hand.splice(inHand, 1);
        player.doneCards.push(c);
      } else if (inDone !== -1) {
        const [c] = player.doneCards.splice(inDone, 1);
        player.hand.push(c);
      }
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      return;
    }

    // --- DECLARE WIN ---
    if (msg.type === 'declare_win') {
      if (!room.gameStarted) return;
      const player = room.players.find(p => p.id === info.playerId);
      room.gameStarted = false;
      broadcastAll(room, pid => ({
        type: 'player_won',
        winnerName: player.name,
        winnerId: player.id,
        isYou: pid === player.id,
        state: getRoomState(room, pid)
      }));
      return;
    }

    // --- CHAT ---
    if (msg.type === 'chat') {
      const player = room.players.find(p => p.id === info.playerId);
      const text = (msg.text||'').substring(0,200).trim();
      if (!text) return;
      broadcastAll(room, () => ({ type: 'chat', name: player?.name||'?', text, fromId: info.playerId }));
      return;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info?.roomId) {
      const room = rooms.get(info.roomId);
      if (room) {
        const p = room.players.find(x => x.id === info.playerId);
        if (p) {
          p.connected = false;
          broadcast(room, { type: 'sys', text: `${p.name} disconnected` });
          broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
        }
      }
    }
    clients.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries())
    if (now - room.createdAt > 3 * 60 * 60 * 1000) rooms.delete(code);
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🃏  SEVENS running → http://localhost:${PORT}\n`);
});
