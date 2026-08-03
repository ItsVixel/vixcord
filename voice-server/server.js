'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const webpush = require('web-push');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://vixcord.onrender.com';
const USERS_API_URL = process.env.MOCKAPI_USERS_URL || 'https://6a638812b30b52361e1a6b8d.mockapi.io/1/users';
const VIXCORD_HTML = path.resolve(__dirname, '..', 'index.html');
const VIXCORD_MANIFEST = path.resolve(__dirname, '..', 'manifest.webmanifest');
const VIXCORD_SERVICE_WORKER = path.resolve(__dirname, '..', 'sw.js');
const VOICE_ROOMS = new Set(['general-voice', 'general-voice-2']);
const roomMembers = new Map([...VOICE_ROOMS].map(roomId => [roomId, new Map()]));
const pushSubscriptions = new Map();
const pushRateBuckets = new Map();
const configuredVapidKeys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : null;
const vapidKeys = configuredVapidKeys || webpush.generateVAPIDKeys();

webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:vixcord@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

const STATIC_FILES = new Map([
  ['/', { file: VIXCORD_HTML, type: 'text/html; charset=utf-8', cache: 'no-store' }],
  ['/index.html', { file: VIXCORD_HTML, type: 'text/html; charset=utf-8', cache: 'no-store' }],
  ['/manifest.webmanifest', { file: VIXCORD_MANIFEST, type: 'application/manifest+json; charset=utf-8', cache: 'no-cache' }],
  ['/sw.js', { file: VIXCORD_SERVICE_WORKER, type: 'application/javascript; charset=utf-8', cache: 'no-cache' }]
]);

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response, status, payload) {
  cors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 60000) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body.')); }
    });
    request.on('error', reject);
  });
}

function pushQuotaAvailable(request) {
  const ip = cleanText(request.headers['x-forwarded-for'] || request.socket.remoteAddress, 100).split(',')[0];
  const now = Date.now();
  const recent = (pushRateBuckets.get(ip) || []).filter(time => now - time < 60000);
  if (recent.length >= 40) return false;
  recent.push(now);
  pushRateBuckets.set(ip, recent);
  return true;
}

function validSubscription(subscription) {
  return subscription && /^https:\/\//i.test(subscription.endpoint || '') && subscription.keys?.p256dh && subscription.keys?.auth;
}

async function sendPush(username, payload) {
  const normalizedUsername = String(username).toLowerCase();
  let devices = pushSubscriptions.get(normalizedUsername);
  if (!devices?.size) {
    try {
      const response = await fetch(USERS_API_URL);
      if (response.ok) {
        const users = await response.json();
        const user = users.find(item => String(item.username || '').toLowerCase() === normalizedUsername);
        const saved = Array.isArray(user?.pushsubscriptions) ? user.pushsubscriptions.filter(validSubscription).slice(-5) : [];
        if (saved.length) {
          devices = new Map(saved.map(subscription => [subscription.endpoint, subscription]));
          pushSubscriptions.set(normalizedUsername, devices);
        }
      }
    } catch {}
  }
  if (!devices) return 0;
  let delivered = 0;
  await Promise.all([...devices.entries()].map(async ([endpoint, subscription]) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      delivered += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) devices.delete(endpoint);
    }
  }));
  if (!devices.size) pushSubscriptions.delete(normalizedUsername);
  return delivered;
}

async function handleHttp(request, response) {
  const requestPath = new URL(request.url, PUBLIC_URL).pathname;
  if (request.method === 'OPTIONS') {
    cors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  const staticFile = request.method === 'GET' ? STATIC_FILES.get(requestPath) : null;
  if (staticFile) {
    fs.readFile(staticFile.file, (error, contents) => {
      if (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(`Could not load ${path.basename(staticFile.file)}.`);
        return;
      }
      response.writeHead(200, {
        'Content-Type': staticFile.type,
        'Cache-Control': staticFile.cache,
        ...(requestPath === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {})
      });
      response.end(contents);
    });
    return;
  }

  if (request.method === 'GET' && requestPath === '/push/vapid-public-key') {
    sendJson(response, 200, { publicKey: vapidKeys.publicKey, persistent: Boolean(configuredVapidKeys) });
    return;
  }

  if (request.method === 'POST' && requestPath === '/push/subscribe') {
    const payload = await readJson(request);
    const username = cleanText(payload.username, 24).toLowerCase();
    if (!username || !validSubscription(payload.subscription)) {
      sendJson(response, 400, { error: 'Invalid push subscription.' });
      return;
    }
    const devices = pushSubscriptions.get(username) || new Map();
    devices.set(payload.subscription.endpoint, payload.subscription);
    while (devices.size > 5) devices.delete(devices.keys().next().value);
    pushSubscriptions.set(username, devices);
    sendJson(response, 201, { subscribed: true, persistent: Boolean(configuredVapidKeys) });
    return;
  }

  if (request.method === 'POST' && requestPath === '/push/send') {
    if (!pushQuotaAvailable(request)) {
      sendJson(response, 429, { error: 'Too many push requests.' });
      return;
    }
    const payload = await readJson(request);
    const recipients = [...new Set((Array.isArray(payload.recipients) ? payload.recipients : []).map(name => cleanText(name, 24).toLowerCase()).filter(Boolean))].slice(0, 25);
    const notification = {
      title: cleanText(payload.title, 80) || 'Vixcord',
      body: cleanText(payload.body, 240),
      url: /^\/[a-z0-9/_-]*$/i.test(payload.url || '') ? payload.url : '/index.html'
    };
    const delivered = (await Promise.all(recipients.map(username => sendPush(username, notification)))).reduce((sum, count) => sum + count, 0);
    sendJson(response, 200, { delivered });
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

const httpServer = http.createServer((request, response) => {
  handleHttp(request, response).catch(error => sendJson(response, 500, { error: error.message || 'Server error.' }));
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
  if (!configuredVapidKeys) console.warn('Using temporary VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on Render for persistent phone push.');
  console.log(`Vixcord voice server running at ${PUBLIC_URL}`);
  console.log(`Open Vixcord at ${PUBLIC_URL}`);
});
