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
const clients = new Map();
const playerSockets = new Map();

function createDeck() {
  const suits = ['S','H','D','C'];
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

function makeAbilityCards(playerId) {
  return [
    { value: '14', id: `ab14_${playerId}`, isAbility: true, abilityIdx: 0 },
    { value: '15', id: `ab15_${playerId}`, isAbility: true, abilityIdx: 1 },
  ];
}

function getRoomState(room, forPlayerId) {
  return {
    code: room.code,
    gameStarted: room.gameStarted,
    deckCount: room.deck.length,
    abilityMode: room.abilityMode,
    initialCards: room.initialCards,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      doneCount: p.doneCards.length,
      abilityCount: (p.abilityCards||[]).length,
      connected: p.connected,
      isYou: p.id === forPlayerId,
      hand:         p.id === forPlayerId ? p.hand         : null,
      doneCards:    p.id === forPlayerId ? p.doneCards    : null,
      abilityCards: p.id === forPlayerId ? p.abilityCards : null,
    })),
  };
}

// Public room list (only lobbies, not started games)
function getPublicRoomList() {
  const list = [];
  for (const [code, room] of rooms) {
    if (!room.gameStarted) {
      list.push({
        code,
        hostName: room.players[0]?.name || '?',
        playerCount: room.players.length,
        maxPlayers: 6,
        abilityMode: room.abilityMode,
        initialCards: room.initialCards,
      });
    }
  }
  return list;
}

function broadcastAll(room, factory) {
  for (const [ws, info] of clients) {
    if (info.roomId === room.code && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(factory(info.playerId)));
  }
}
function broadcast(room, msg, excludeId = null) {
  for (const [ws, info] of clients) {
    if (info.roomId === room.code && info.playerId !== excludeId && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(msg));
  }
}
function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Broadcast updated room list to everyone in lobby (no roomId)
function broadcastRoomList() {
  const list = getPublicRoomList();
  for (const [ws, info] of clients) {
    if (!info.roomId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
    }
  }
}

wss.on('connection', (ws) => {
  const connId = uuidv4();
  clients.set(ws, { playerId: connId, roomId: null, playerName: '' });

  const newTimer = setTimeout(() => {
    if (clients.get(ws)?.playerId === connId) {
      sendTo(ws, { type: 'connected', playerId: connId });
      // Send room list to fresh connections
      sendTo(ws, { type: 'room_list', rooms: getPublicRoomList() });
    }
  }, 200);
  clients.get(ws)._newTimer = newTimer;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;

    // ── RECONNECT ────────────────────────────────────────────
    if (msg.type === 'reconnect') {
      clearTimeout(info._newTimer);
      info._newTimer = null;

      const { savedPlayerId, savedRoomCode } = msg;
      const room = savedRoomCode && rooms.get(savedRoomCode);
      if (!room) {
        sendTo(ws, { type: 'connected', playerId: connId });
        sendTo(ws, { type: 'room_list', rooms: getPublicRoomList() });
        sendTo(ws, { type: 'reconnect_failed' });
        return;
      }
      const player = room.players.find(p => p.id === savedPlayerId);
      if (!player) {
        sendTo(ws, { type: 'connected', playerId: connId });
        sendTo(ws, { type: 'room_list', rooms: getPublicRoomList() });
        sendTo(ws, { type: 'reconnect_failed' });
        return;
      }

      const oldWs = playerSockets.get(savedPlayerId);
      if (oldWs && oldWs !== ws) {
        const oldInfo = clients.get(oldWs);
        if (oldInfo) clearTimeout(oldInfo._newTimer);
        clients.delete(oldWs);
      }

      info.playerId = savedPlayerId;
      info.roomId   = savedRoomCode;
      info.playerName = player.name;
      player.connected = true;
      playerSockets.set(savedPlayerId, ws);

      sendTo(ws, {
        type: 'reconnected',
        playerId: savedPlayerId,
        hostId: room.hostId,
        state: getRoomState(room, savedPlayerId),
        gameStarted: room.gameStarted,
      });
      broadcast(room, { type: 'sys', text: `${player.name} reconnected` }, savedPlayerId);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      return;
    }

    // ── GET ROOM LIST ────────────────────────────────────────
    if (msg.type === 'get_rooms') {
      sendTo(ws, { type: 'room_list', rooms: getPublicRoomList() });
      return;
    }

    // ── CREATE ROOM ──────────────────────────────────────────
    if (msg.type === 'create_room') {
      clearTimeout(info._newTimer);
      const code = Math.random().toString(36).substring(2,7).toUpperCase();
      const name = (msg.name||'Host').substring(0,18);
      info.playerName = name;
      info.roomId = code;
      playerSockets.set(connId, ws);

      const room = {
        code, hostId: connId,
        players: [{ id: connId, name, hand: [], doneCards: [], abilityCards: [], connected: true }],
        deck: [], gameStarted: false, abilityMode: false,
        initialCards: 7,  // default
        createdAt: Date.now()
      };
      rooms.set(code, room);
      sendTo(ws, { type: 'connected', playerId: connId });
      sendTo(ws, { type: 'room_created', code, playerId: connId, state: getRoomState(room, connId) });
      broadcastRoomList(); // update lobby browsers
      return;
    }

    // ── JOIN ROOM ────────────────────────────────────────────
    if (msg.type === 'join_room') {
      clearTimeout(info._newTimer);
      const code = (msg.code||'').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room)              { sendTo(ws, { type: 'connected', playerId: connId }); sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
      if (room.gameStarted)   { sendTo(ws, { type: 'connected', playerId: connId }); sendTo(ws, { type: 'error', message: 'Game already started' }); return; }
      if (room.players.length >= 6) { sendTo(ws, { type: 'connected', playerId: connId }); sendTo(ws, { type: 'error', message: 'Room full (max 6)' }); return; }

      const name = (msg.name||'Player').substring(0,18);
      info.playerName = name;
      info.roomId = code;
      playerSockets.set(connId, ws);
      room.players.push({ id: connId, name, hand: [], doneCards: [], abilityCards: [], connected: true });

      sendTo(ws, { type: 'connected', playerId: connId });
      sendTo(ws, { type: 'room_joined', code, playerId: connId, state: getRoomState(room, connId) });
      broadcast(room, { type: 'sys', text: `${name} joined` }, connId);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      broadcastRoomList();
      return;
    }

    const room = info.roomId && rooms.get(info.roomId);
    if (!room) return;

    // ── TOGGLE ABILITY MODE ──────────────────────────────────
    if (msg.type === 'toggle_ability_mode') {
      if (room.hostId !== info.playerId || room.gameStarted) return;
      room.abilityMode = !room.abilityMode;
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      broadcastAll(room, () => ({ type: 'sys', text: room.abilityMode ? '⚡ ABILITY MODE ON.' : 'Ability mode OFF.' }));
      broadcastRoomList();
      return;
    }

    // ── SET INITIAL CARDS ────────────────────────────────────
    if (msg.type === 'set_initial_cards') {
      if (room.hostId !== info.playerId || room.gameStarted) return;
      const n = Math.max(1, Math.min(10, parseInt(msg.count) || 7));
      room.initialCards = n;
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      broadcastRoomList();
      return;
    }

    // ── START GAME ───────────────────────────────────────────
    if (msg.type === 'start_game') {
      if (room.hostId !== info.playerId) return;
      if (room.players.length < 2) { sendTo(ws, { type: 'error', message: 'Need at least 2 players' }); return; }

      const n = room.initialCards || 7;
      room.deck = createDeck();
      for (const p of room.players) {
        p.hand = room.deck.splice(0, n);
        p.doneCards = [];
        p.abilityCards = room.abilityMode ? makeAbilityCards(p.id) : [];
      }
      room.gameStarted = true;

      broadcastAll(room, pid => ({ type: 'game_started', state: getRoomState(room, pid) }));
      const startMsg = room.abilityMode
        ? `Game on! ${n} cards + 2 ability cards each.`
        : `Game started! ${n} cards each.`;
      broadcastAll(room, () => ({ type: 'sys', text: startMsg }));
      broadcastRoomList(); // remove from public list
      return;
    }

    // ── DRAW CARD ────────────────────────────────────────────
    if (msg.type === 'draw_card') {
      if (!room.gameStarted) return;
      if (room.deck.length === 0) { sendTo(ws, { type: 'error', message: 'Deck is empty!' }); return; }
      const player = room.players.find(p => p.id === info.playerId);
      if (!player) return;
      const card = room.deck.splice(0, 1)[0];
      player.hand.push(card);
      broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
      broadcast(room, { type: 'sys', text: `${player.name} drew a card` }, info.playerId);
      return;
    }

    // ── TOGGLE DONE ──────────────────────────────────────────
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

    // ── USE ABILITY ──────────────────────────────────────────
    if (msg.type === 'use_ability') {
      if (!room.gameStarted || !room.abilityMode) return;
      const player = room.players.find(p => p.id === info.playerId);
      if (!player) return;

      const { cardId, abilityIdx } = msg;
      const abilityPos = player.abilityCards.findIndex(c => c.id === cardId);
      if (abilityPos === -1) return;

      const abilityValue = String(abilityIdx === 0 ? '14' : '15');
      for (const p of room.players) {
        p.abilityCards = p.abilityCards.filter(c => c.value !== abilityValue);
      }

      const opponents = room.players.filter(p => p.id !== info.playerId);

      if (abilityIdx === 0) {
        const reveals = opponents.map(opp => {
          if (!opp.hand.length) return null;
          const card = opp.hand[Math.floor(Math.random() * opp.hand.length)];
          return { playerId: opp.id, playerName: opp.name, card };
        }).filter(Boolean);

        sendTo(playerSockets.get(info.playerId), {
          type: 'ability_used', abilityIdx: 0,
          casterName: player.name, casterId: player.id,
          reveals, isCaster: true,
          state: getRoomState(room, info.playerId),
        });
        for (const [ws2, info2] of clients) {
          if (info2.roomId === room.code && info2.playerId !== info.playerId && ws2.readyState === WebSocket.OPEN) {
            ws2.send(JSON.stringify({
              type: 'ability_used', abilityIdx: 0,
              casterName: player.name, casterId: player.id,
              reveals: null, isCaster: false,
              state: getRoomState(room, info2.playerId),
            }));
          }
        }
        return;
      }

      if (abilityIdx === 1) {
        if (player.hand.length === 0) {
          player.abilityCards.push({ value: '15', id: cardId, isAbility: true, abilityIdx: 1 });
          sendTo(ws, { type: 'error', message: 'No cards to give!' });
          return;
        }
        const giveCard = player.hand.splice(Math.floor(Math.random() * player.hand.length), 1)[0];
        const target = opponents[Math.floor(Math.random() * opponents.length)];
        target.hand.push(giveCard);

        broadcastAll(room, pid => ({
          type: 'ability_used', abilityIdx: 1,
          casterName: player.name, casterId: player.id,
          targetName: target.name, targetId: target.id,
          givenCard: giveCard,
          state: getRoomState(room, pid),
        }));
        return;
      }
    }

    // ── DECLARE WIN ──────────────────────────────────────────
    if (msg.type === 'declare_win') {
      if (!room.gameStarted) return;
      const player = room.players.find(p => p.id === info.playerId);
      room.gameStarted = false;
      broadcastAll(room, pid => ({
        type: 'player_won',
        winnerName: player.name, winnerId: player.id,
        isYou: pid === player.id,
        state: getRoomState(room, pid),
      }));
      return;
    }

    // ── CHAT ─────────────────────────────────────────────────
    if (msg.type === 'chat') {
      const player = room.players.find(p => p.id === info.playerId);
      const text = (msg.text||'').substring(0, 200).trim();
      if (!text) return;
      broadcastAll(room, () => ({ type: 'chat', name: player?.name||'?', text, fromId: info.playerId }));
      return;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      clearTimeout(info._newTimer);
      if (info.roomId) {
        const room = rooms.get(info.roomId);
        if (room) {
          const p = room.players.find(x => x.id === info.playerId);
          if (p) {
            p.connected = false;
            broadcast(room, { type: 'sys', text: `${p.name} disconnected` });
            broadcastAll(room, pid => ({ type: 'state_update', state: getRoomState(room, pid) }));
          }
        }
      } else {
        // Was in lobby — no need to update room list
      }
      clients.delete(ws);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms)
    if (now - room.createdAt > 3 * 60 * 60 * 1000) rooms.delete(code);
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🃏  SEVENS → http://localhost:${PORT}\n`));
