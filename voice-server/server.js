'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://vixcord.onrender.com';
const VIXCORD_HTML = path.resolve(__dirname, '..', 'vixcord-enhanced.html');
const VOICE_ROOMS = new Set(['general-voice', 'general-voice-2']);
const roomMembers = new Map([...VOICE_ROOMS].map(roomId => [roomId, new Map()]));

const httpServer = http.createServer((request, response) => {
  const requestPath = new URL(request.url, PUBLIC_URL).pathname;
  if (requestPath === '/' || requestPath === '/vixcord-enhanced.html') {
    fs.readFile(VIXCORD_HTML, (error, html) => {
      if (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Could not load vixcord-enhanced.html. Keep voice-server beside the HTML file.');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html);
    });
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 250000
});

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanUser(rawUser) {
  const username = cleanText(rawUser?.username, 24);
  if (!username) return null;
  const avatar = cleanText(rawUser?.avatar, 50000);
  return {
    username,
    displayName: cleanText(rawUser?.displayName, 24) || username,
    avatar: /^(https?:\/\/|data:image\/)/i.test(avatar) ? avatar : '',
    avatarcolor: cleanText(rawUser?.avatarcolor, 20),
    namecolor: cleanText(rawUser?.namecolor, 20),
    rank: cleanText(rawUser?.rank, 20)
  };
}

function usersIn(roomId) {
  return [...roomMembers.get(roomId).entries()].map(([socketId, user]) => ({ socketId, ...user }));
}

function emitPresence(roomId) {
  io.emit('voice:presence', { roomId, users: usersIn(roomId) });
}

function leaveVoiceRoom(socket) {
  const roomId = socket.data.voiceRoom;
  if (!roomId || !VOICE_ROOMS.has(roomId)) return;
  roomMembers.get(roomId).delete(socket.id);
  socket.to(roomId).emit('voice:user-left', { socketId: socket.id });
  socket.leave(roomId);
  socket.data.voiceRoom = null;
  emitPresence(roomId);
}

function relay(socket, eventName, payload) {
  const target = cleanText(payload?.target, 100);
  if (!target || !socket.data.voiceRoom) return;
  const targetSocket = io.sockets.sockets.get(target);
  if (!targetSocket || targetSocket.data.voiceRoom !== socket.data.voiceRoom) return;
  targetSocket.emit(eventName, {
    from: socket.id,
    description: payload.description,
    candidate: payload.candidate
  });
}

io.on('connection', socket => {
  for (const roomId of VOICE_ROOMS) socket.emit('voice:presence', { roomId, users: usersIn(roomId) });

  socket.on('voice:join', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const user = cleanUser(payload?.user);
    if (!VOICE_ROOMS.has(roomId) || !user) {
      socket.emit('voice:error', 'Invalid voice room or user.');
      return;
    }
    if (socket.data.voiceRoom === roomId) return;
    leaveVoiceRoom(socket);
    const existingUsers = usersIn(roomId);
    socket.join(roomId);
    socket.data.voiceRoom = roomId;
    roomMembers.get(roomId).set(socket.id, user);
    socket.emit('voice:existing-users', existingUsers);
    emitPresence(roomId);
  });

  socket.on('voice:leave', () => leaveVoiceRoom(socket));
  socket.on('voice:offer', payload => relay(socket, 'voice:offer', payload));
  socket.on('voice:answer', payload => relay(socket, 'voice:answer', payload));
  socket.on('voice:ice', payload => relay(socket, 'voice:ice', payload));
  socket.on('disconnecting', () => leaveVoiceRoom(socket));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Vixcord voice server running at ${PUBLIC_URL}`);
  console.log(`Open Vixcord at ${PUBLIC_URL}`);
});
