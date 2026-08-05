'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const webpush = require('web-push');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://vixcord.onrender.com';
const USERS_API_URL = process.env.MOCKAPI_USERS_URL || 'https://6a638812b30b52361e1a6b8d.mockapi.io/1/users';
const LOGINS_API_URL = process.env.MOCKAPI_LOGINS_URL || 'https://6a638812b30b52361e1a6b8d.mockapi.io/1/logins';
const GENERAL_CHAT_API_URL = process.env.MOCKAPI_GENERAL_CHAT_URL || 'https://6a63dbd7b30b52361e1aab35.mockapi.io/2/chat1';
const CHAT_API_URLS = {
  chat1: GENERAL_CHAT_API_URL,
  chat2: process.env.MOCKAPI_CHAT2_URL || 'https://6a63dbd7b30b52361e1aab35.mockapi.io/2/chat2',
  chat3: process.env.MOCKAPI_CHAT3_URL || 'https://6a63dd06b30b52361e1aabe1.mockapi.io/3/chat3',
  chat4: process.env.MOCKAPI_CHAT4_URL || 'https://6a63dd06b30b52361e1aabe1.mockapi.io/3/chat4'
};
const VIXCORD_HTML = path.resolve(__dirname, '..', 'index.html');
const VIXCORD_MANIFEST = path.resolve(__dirname, '..', 'manifest.webmanifest');
const VIXCORD_SERVICE_WORKER = path.resolve(__dirname, '..', 'sw.js');
const VOICE_ROOMS = new Set(['general-voice', 'general-voice-2']);
const roomMembers = new Map([...VOICE_ROOMS].map(roomId => [roomId, new Map()]));
const pushSubscriptions = new Map();
const pushMissCache = new Map();
const pushRateBuckets = new Map();
const sessionRateBuckets = new Map();
const pushDeduplication = new Map();
const coinFlipLocks = new Map();
const channelClearLocks = new Map();
const reactionUpdateLocks = new Map();
const COIN_FLIP_EXPIRY_MS = 2 * 60 * 1000;
const REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥', '🤓', '🐦‍⬛', '😭', '🥀', '💀', '🗿']);
const configuredSessionSecret = process.env.SESSION_SECRET;
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
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
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response, status, payload) {
  cors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Data API error (${response.status}).`);
  return data;
}

const normalizedName = value => cleanText(value, 24).toLowerCase();
const pairKey = (left, right) => [String(left), String(right)].sort().join(':');
const activeCoinFlip = request => request?.status === 'pending' && Number(request.expiresAt) > Date.now();

function signSession(username) {
  const payload = Buffer.from(JSON.stringify({ sub: username, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function authenticatedUsername(request) {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new HttpError(401, 'Sign in again before using coin flip.');
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new HttpError(401, 'Your session is invalid.'); }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw new HttpError(401, 'Your session is invalid.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new HttpError(401, 'Your session is invalid.'); }
  if (!decoded.sub || Number(decoded.exp) < Date.now()) throw new HttpError(401, 'Your session expired. Sign in again.');
  return normalizedName(decoded.sub);
}

async function createSession(payload) {
  const username = normalizedName(payload.username), password = String(payload.password || '');
  if (!username || password.length < 4 || password.length > 256) throw new HttpError(400, 'Invalid username or password.');
  const logins = await apiJson(LOGINS_API_URL), login = logins.find(item => normalizedName(item.username) === username);
  const [, salt, savedHash] = String(login?.password || '').split('$');
  if (!salt || !savedHash) throw new HttpError(401, 'Invalid username or password.');
  const suppliedHash = crypto.createHash('sha256').update(`${salt}|${password}`).digest('base64url');
  const saved = Buffer.from(savedHash), supplied = Buffer.from(suppliedHash);
  if (saved.length !== supplied.length || !crypto.timingSafeEqual(saved, supplied)) throw new HttpError(401, 'Invalid username or password.');
  return { token: signSession(login.username), expiresIn: 7 * 86400 };
}

async function withCoinFlipLock(key, task) {
  const previous = coinFlipLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  coinFlipLocks.set(key, gate);
  await previous;
  try { return await task(); }
  finally { release(); if (coinFlipLocks.get(key) === gate) coinFlipLocks.delete(key); }
}

async function clearChannel(username, channel) {
  const url = CHAT_API_URLS[channel];
  if (!url) throw new HttpError(400, 'That channel cannot be cleared.');
  const users = await apiJson(USERS_API_URL), user = users.find(item => normalizedName(item.username) === username);
  const role = String(user?.rank || 'member').toLowerCase().replace(/_/g, '-');
  if (!['admin', 'owner'].includes(role)) throw new HttpError(403, 'Only admins and owners can clear channels.');
  const previous = channelClearLocks.get(channel) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    let removed = 0;
    for (let pass = 0; pass < 8; pass++) {
      const messages = await apiJson(url);
      if (!Array.isArray(messages) || !messages.length) return { removed };
      for (let index = 0; index < messages.length; index += 10) {
        const results = await Promise.allSettled(messages.slice(index, index + 10).map(message => apiJson(`${url}/${encodeURIComponent(message.id)}`, { method: 'DELETE' })));
        removed += results.filter(result => result.status === 'fulfilled').length;
      }
    }
    const remaining = await apiJson(url);
    if (remaining.length) throw new HttpError(409, 'New messages kept arriving during the clear. Run /clear again.');
    return { removed };
  });
  channelClearLocks.set(channel, operation);
  try { return await operation; }
  finally { if (channelClearLocks.get(channel) === operation) channelClearLocks.delete(channel); }
}

async function toggleMessageReaction(username, payload) {
  const channel = cleanText(payload.channel, 10), messageId = cleanText(payload.messageId, 100), emoji = cleanText(payload.emoji, 20);
  const url = CHAT_API_URLS[channel];
  if (!url || !messageId || !REACTION_EMOJIS.has(emoji)) throw new HttpError(400, 'Invalid reaction request.');
  const key = `${channel}:${messageId}`, previous = reactionUpdateLocks.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const message = await apiJson(`${url}/${encodeURIComponent(messageId)}`), reactions = { ...(message.reactions || {}) };
    const usernames = Array.isArray(reactions[emoji]) ? reactions[emoji].map(String) : [];
    const index = usernames.findIndex(item => item.toLowerCase() === username);
    if (index >= 0) usernames.splice(index, 1); else usernames.push(username);
    if (usernames.length) reactions[emoji] = [...new Set(usernames)]; else delete reactions[emoji];
    return apiJson(`${url}/${encodeURIComponent(messageId)}`, { method: 'PUT', body: JSON.stringify({ reactions }) });
  });
  reactionUpdateLocks.set(key, operation);
  try { return await operation; }
  finally { if (reactionUpdateLocks.get(key) === operation) reactionUpdateLocks.delete(key); }
}

async function postSystemMessage(message) {
  try {
    await apiJson(GENERAL_CHAT_API_URL, { method: 'POST', body: JSON.stringify({
      messeges: message,
      time: new Date().toISOString(),
      username: 'vixcord',
      to: null,
      rank: 'system',
      equippedrank: '',
      namecolor: '#9ca3af',
      badges: [],
      equippedbadges: [],
      attachments: [],
      reply: null,
      reactions: {}
    }) });
  } catch (error) { console.warn('Could not post coin flip result:', error.message); }
}

async function createCoinFlip(payload) {
  const senderName = normalizedName(payload.username), targetName = normalizedName(payload.target);
  const amount = Number(payload.amount);
  if (!senderName || !targetName) throw new HttpError(400, 'Choose a valid coin flip opponent.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'The wager must be a positive whole number.');
  if (senderName === targetName) throw new HttpError(400, 'You cannot coin flip against yourself.');
  let users = await apiJson(USERS_API_URL);
  let sender = users.find(user => normalizedName(user.username) === senderName);
  let target = users.find(user => normalizedName(user.username) === targetName);
  if (!sender || !target) throw new HttpError(404, 'That user does not exist.');
  return withCoinFlipLock(pairKey(sender.id, target.id), async () => {
    users = await apiJson(USERS_API_URL);
    sender = users.find(user => String(user.id) === String(sender.id));
    target = users.find(user => String(user.id) === String(target.id));
    if (!sender || !target) throw new HttpError(404, 'A coin flip player no longer exists.');
    if (Number(sender.coins || 0) < amount) throw new HttpError(400, 'You do not have enough coins for that wager.');
    const duplicate = users.some(user => (Array.isArray(user.coinfliprequests) ? user.coinfliprequests : []).some(request =>
      activeCoinFlip(request) && pairKey(request.fromId, request.toId) === pairKey(sender.id, target.id)
    ));
    if (duplicate) throw new HttpError(409, 'There is already an active coin flip between these users.');
    const request = {
      id: crypto.randomUUID(),
      from: sender.username,
      fromId: sender.id,
      to: target.username,
      toId: target.id,
      amount,
      createdAt: Date.now(),
      expiresAt: Date.now() + COIN_FLIP_EXPIRY_MS,
      status: 'pending'
    };
    const requests = [...(Array.isArray(target.coinfliprequests) ? target.coinfliprequests : []).filter(item => Number(item.expiresAt) > Date.now() - 86400000), request].slice(-20);
    const updatedTarget = await apiJson(`${USERS_API_URL}/${encodeURIComponent(target.id)}`, { method: 'PUT', body: JSON.stringify({ coinfliprequests: requests }) });
    await sendPush(target.username, { title: 'Coin flip challenge', body: `@${sender.username} challenged you for ${amount} coins. Type /cf accept or /cf deny.`, url: './index.html' });
    return { title: 'Coin flip sent', message: `${target.username} has 2 minutes to accept your ${amount}-coin challenge.`, users: [sender, updatedTarget] };
  });
}

async function respondToCoinFlip(payload) {
  const username = normalizedName(payload.username), action = cleanText(payload.action, 10).toLowerCase();
  if (!username || !['accept', 'deny'].includes(action)) throw new HttpError(400, 'Use /cf accept or /cf deny.');
  let users = await apiJson(USERS_API_URL);
  let receiver = users.find(user => normalizedName(user.username) === username);
  if (!receiver) throw new HttpError(404, 'Your user account was not found.');
  let requests = Array.isArray(receiver.coinfliprequests) ? receiver.coinfliprequests : [];
  let pending = [...requests].reverse().find(request => activeCoinFlip(request) && String(request.toId) === String(receiver.id));
  if (!pending) {
    const expired = [...requests].reverse().find(request => request?.status === 'pending' && String(request.toId) === String(receiver.id));
    if (expired) {
      requests = requests.map(request => request.id === expired.id ? { ...request, status: 'expired' } : request);
      await apiJson(`${USERS_API_URL}/${encodeURIComponent(receiver.id)}`, { method: 'PUT', body: JSON.stringify({ coinfliprequests: requests }) });
      throw new HttpError(410, 'That coin flip request expired.');
    }
    throw new HttpError(404, 'You do not have an active coin flip request.');
  }
  return withCoinFlipLock(pairKey(pending.fromId, pending.toId), async () => {
    users = await apiJson(USERS_API_URL);
    receiver = users.find(user => String(user.id) === String(pending.toId));
    const sender = users.find(user => String(user.id) === String(pending.fromId));
    if (!receiver || !sender) throw new HttpError(404, 'A coin flip player no longer exists.');
    requests = Array.isArray(receiver.coinfliprequests) ? receiver.coinfliprequests : [];
    pending = requests.find(request => request.id === pending.id);
    if (!activeCoinFlip(pending)) throw new HttpError(409, 'That coin flip was already handled or expired.');
    if (action === 'deny') {
      const updatedRequests = requests.map(request => request.id === pending.id ? { ...request, status: 'denied', resolvedAt: Date.now() } : request);
      const updatedReceiver = await apiJson(`${USERS_API_URL}/${encodeURIComponent(receiver.id)}`, { method: 'PUT', body: JSON.stringify({ coinfliprequests: updatedRequests }) });
      await sendPush(sender.username, { title: 'Coin flip denied', body: `@${receiver.username} denied your ${pending.amount}-coin challenge.`, url: './index.html' });
      return { title: 'Coin flip denied', message: `You denied ${sender.username}'s challenge.`, users: [sender, updatedReceiver] };
    }
    const amount = Number(pending.amount), senderCoins = Number(sender.coins || 0), receiverCoins = Number(receiver.coins || 0);
    if (senderCoins < amount || receiverCoins < amount) {
      const updatedRequests = requests.map(request => request.id === pending.id ? { ...request, status: 'cancelled', resolvedAt: Date.now() } : request);
      const updatedReceiver = await apiJson(`${USERS_API_URL}/${encodeURIComponent(receiver.id)}`, { method: 'PUT', body: JSON.stringify({ coinfliprequests: updatedRequests }) });
      throw new HttpError(409, `${senderCoins < amount ? sender.username : receiver.username} no longer has enough coins. The challenge was cancelled.`);
    }
    const senderWon = crypto.randomInt(2) === 0;
    const senderBalance = senderCoins + (senderWon ? amount : -amount);
    const receiverBalance = receiverCoins + (senderWon ? -amount : amount);
    const updatedRequests = requests.map(request => request.id === pending.id ? { ...request, status: 'accepted', winner: senderWon ? sender.username : receiver.username, resolvedAt: Date.now() } : request);
    let updatedSender;
    try {
      updatedSender = await apiJson(`${USERS_API_URL}/${encodeURIComponent(sender.id)}`, { method: 'PUT', body: JSON.stringify({ coins: senderBalance }) });
      const updatedReceiver = await apiJson(`${USERS_API_URL}/${encodeURIComponent(receiver.id)}`, { method: 'PUT', body: JSON.stringify({ coins: receiverBalance, coinfliprequests: updatedRequests }) });
      const winner = senderWon ? updatedSender : updatedReceiver, loser = senderWon ? updatedReceiver : updatedSender;
      const announcement = `🪙 @${winner.username} won ${amount} coins from @${loser.username} in a coin flip!`;
      await Promise.allSettled([
        sendPush(sender.username, { title: senderWon ? 'You won the coin flip!' : 'You lost the coin flip', body: announcement, url: './index.html' }),
        sendPush(receiver.username, { title: senderWon ? 'You lost the coin flip' : 'You won the coin flip!', body: announcement, url: './index.html' }),
        postSystemMessage(announcement)
      ]);
      return { title: senderWon ? `${sender.username} won!` : `${receiver.username} won!`, message: announcement, users: [updatedSender, updatedReceiver] };
    } catch (error) {
      if (updatedSender) await apiJson(`${USERS_API_URL}/${encodeURIComponent(sender.id)}`, { method: 'PUT', body: JSON.stringify({ coins: senderCoins }) }).catch(() => {});
      throw error;
    }
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '', tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 60000) { tooLarge = true; body = ''; }
    });
    request.on('end', () => {
      if (tooLarge) { reject(new HttpError(413, 'Request body is too large.')); return; }
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new HttpError(400, 'Invalid JSON body.')); }
    });
    request.on('error', reject);
  });
}

function pushQuotaAvailable(request) {
  const ip = cleanText(request.headers['x-forwarded-for'] || request.socket.remoteAddress, 100).split(',')[0];
  const now = Date.now();
  if (pushRateBuckets.size > 1000) for (const [key, times] of pushRateBuckets) if (!times.some(time => now - time < 60000)) pushRateBuckets.delete(key);
  const recent = (pushRateBuckets.get(ip) || []).filter(time => now - time < 60000);
  if (recent.length >= 40) return false;
  recent.push(now);
  pushRateBuckets.set(ip, recent);
  return true;
}

function sessionQuotaAvailable(request) {
  const ip = cleanText(request.headers['x-forwarded-for'] || request.socket.remoteAddress, 100).split(',')[0];
  const now = Date.now(), recent = (sessionRateBuckets.get(ip) || []).filter(time => now - time < 60000);
  if (recent.length >= 10) return false;
  recent.push(now); sessionRateBuckets.set(ip, recent);
  if (sessionRateBuckets.size > 1000) for (const [key, times] of sessionRateBuckets) if (!times.some(time => now - time < 60000)) sessionRateBuckets.delete(key);
  return true;
}

function validSubscription(subscription) {
  return subscription && /^https:\/\//i.test(subscription.endpoint || '') && subscription.keys?.p256dh && subscription.keys?.auth;
}

async function sendPush(username, payload) {
  const normalizedUsername = String(username).toLowerCase();
  payload = { ...payload, tag: payload.tag || `vixcord-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` };
  let devices = pushSubscriptions.get(normalizedUsername);
  if (!devices?.size && Date.now() - (pushMissCache.get(normalizedUsername) || 0) < 60000) return 0;
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
  if (!devices) { pushMissCache.set(normalizedUsername, Date.now()); return 0; }
  let delivered = 0;
  await Promise.all([...devices.entries()].map(async ([endpoint, subscription]) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      delivered += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) devices.delete(endpoint);
    }
  }));
  if (!devices.size) { pushSubscriptions.delete(normalizedUsername); pushMissCache.set(normalizedUsername, Date.now()); }
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

  if (request.method === 'POST' && requestPath === '/session') {
    if (!sessionQuotaAvailable(request)) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
    sendJson(response, 200, await createSession(await readJson(request)));
    return;
  }

  if (request.method === 'POST' && requestPath === '/push/subscribe') {
    const payload = await readJson(request);
    const username = authenticatedUsername(request);
    if (!username || !validSubscription(payload.subscription)) {
      sendJson(response, 400, { error: 'Invalid push subscription.' });
      return;
    }
    const devices = pushSubscriptions.get(username) || new Map();
    devices.set(payload.subscription.endpoint, payload.subscription);
    while (devices.size > 5) devices.delete(devices.keys().next().value);
    pushSubscriptions.set(username, devices);
    pushMissCache.delete(username);
    sendJson(response, 201, { subscribed: true, persistent: Boolean(configuredVapidKeys) });
    return;
  }

  if (request.method === 'POST' && requestPath === '/push/send') {
    authenticatedUsername(request);
    if (!pushQuotaAvailable(request)) {
      sendJson(response, 429, { error: 'Too many push requests.' });
      return;
    }
    const payload = await readJson(request);
    const recipients = [...new Set((Array.isArray(payload.recipients) ? payload.recipients : []).map(name => cleanText(name, 24).toLowerCase()).filter(Boolean))].slice(0, 25);
    const notification = {
      title: cleanText(payload.title, 80) || 'Vixcord',
      body: cleanText(payload.body, 240),
      url: /^(?:\.\/|\/)[a-z0-9/_.-]*$/i.test(payload.url || '') ? payload.url : './index.html'
    };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([recipients.sort(), notification.title, notification.body])).digest('hex');
    const now = Date.now(), lastSent = pushDeduplication.get(fingerprint) || 0;
    for (const [key, sentAt] of pushDeduplication) if (now - sentAt > 60000) pushDeduplication.delete(key);
    if (now - lastSent < 5000) {
      sendJson(response, 200, { delivered: 0, duplicate: true });
      return;
    }
    pushDeduplication.set(fingerprint, now);
    const delivered = (await Promise.all(recipients.map(username => sendPush(username, notification)))).reduce((sum, count) => sum + count, 0);
    sendJson(response, 200, { delivered });
    return;
  }

  if (request.method === 'POST' && requestPath === '/coinflip/request') {
    if (!pushQuotaAvailable(request)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
    const payload = await readJson(request);
    payload.username = authenticatedUsername(request);
    sendJson(response, 201, await createCoinFlip(payload));
    return;
  }

  if (request.method === 'POST' && requestPath === '/coinflip/respond') {
    if (!pushQuotaAvailable(request)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
    const payload = await readJson(request);
    payload.username = authenticatedUsername(request);
    sendJson(response, 200, await respondToCoinFlip(payload));
    return;
  }

  if (request.method === 'POST' && requestPath === '/channels/clear') {
    if (!pushQuotaAvailable(request)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
    const payload = await readJson(request), username = authenticatedUsername(request);
    sendJson(response, 200, await clearChannel(username, cleanText(payload.channel, 10)));
    return;
  }

  if (request.method === 'POST' && requestPath === '/reactions/toggle') {
    if (!pushQuotaAvailable(request)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
    const payload = await readJson(request), username = authenticatedUsername(request);
    sendJson(response, 200, await toggleMessageReaction(username, payload));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

const httpServer = http.createServer((request, response) => {
  handleHttp(request, response).catch(error => {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || 'Server error.' });
    else response.end();
  });
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
  if (eventName === 'voice:offer' || eventName === 'voice:answer') {
    if (!payload?.description || !['offer', 'answer'].includes(payload.description.type) || cleanText(payload.description.sdp, 200000).length < 10) return;
  }
  if (eventName === 'voice:ice' && (!payload?.candidate || cleanText(payload.candidate.candidate, 3000).length < 1)) return;
  targetSocket.emit(eventName, {
    from: socket.id,
    description: payload.description,
    candidate: payload.candidate
  });
}

io.on('connection', socket => {
  for (const roomId of VOICE_ROOMS) socket.emit('voice:presence', { roomId, users: usersIn(roomId) });

  socket.on('voice:join', (payload, acknowledge = () => {}) => {
    const roomId = cleanText(payload?.roomId, 40);
    const user = cleanUser(payload?.user);
    if (!VOICE_ROOMS.has(roomId) || !user) {
      socket.emit('voice:error', 'Invalid voice room or user.');
      acknowledge({ ok: false, error: 'Invalid voice room or user.' });
      return;
    }
    if (socket.data.voiceRoom === roomId) {
      roomMembers.get(roomId).set(socket.id, user);
      socket.emit('voice:existing-users', usersIn(roomId).filter(member => member.socketId !== socket.id));
      emitPresence(roomId);
      acknowledge({ ok: true, roomId });
      return;
    }
    leaveVoiceRoom(socket);
    const existingUsers = usersIn(roomId);
    if (existingUsers.length >= 12) {
      acknowledge({ ok: false, error: 'This voice channel is full.' });
      return;
    }
    socket.join(roomId);
    socket.data.voiceRoom = roomId;
    roomMembers.get(roomId).set(socket.id, user);
    socket.emit('voice:existing-users', existingUsers);
    emitPresence(roomId);
    acknowledge({ ok: true, roomId });
  });

  socket.on('voice:leave', () => leaveVoiceRoom(socket));
  socket.on('voice:offer', payload => relay(socket, 'voice:offer', payload));
  socket.on('voice:answer', payload => relay(socket, 'voice:answer', payload));
  socket.on('voice:ice', payload => relay(socket, 'voice:ice', payload));
  socket.on('disconnecting', () => leaveVoiceRoom(socket));
});

httpServer.listen(PORT, HOST, () => {
  if (!configuredVapidKeys) console.warn('Using temporary VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on Render for persistent phone push.');
  if (!configuredSessionSecret) console.warn('Using a temporary session secret. Set SESSION_SECRET on Render so coin flip sessions survive restarts.');
  console.log(`Vixcord voice server running at ${PUBLIC_URL}`);
  console.log(`Open Vixcord at ${PUBLIC_URL}`);
});
