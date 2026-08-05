'use strict';

const { io } = require('socket.io-client');

const serverUrl = process.env.TEST_SERVER_URL || 'http://localhost:4173';
const rooms = ['general-voice', 'general-voice-2'];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(serverUrl, { transports: ['websocket'], forceNew: true, timeout: 4000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function join(socket, roomId, suffix) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit('voice:join', {
      roomId,
      user: { username: `voice-test-${suffix}`, displayName: `Voice Test ${suffix}`, rank: 'member' }
    }, (error, result) => {
      if (error) reject(error);
      else if (!result?.ok) reject(new Error(result?.error || 'Join was rejected.'));
      else resolve(result);
    });
  });
}

function once(socket, event, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), 4000);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}

(async () => {
  const first = await connect(), second = await connect();
  try {
    for (const room of rooms) {
      await join(first, room, 'a');
      const existingUsers = once(second, 'voice:existing-users', `${room}: existing users timed out`);
      await join(second, room, 'b');
      if (!(await existingUsers).some(user => user.socketId === first.id)) throw new Error(`${room}: first peer was missing from presence.`);

      const relayedOffer = once(first, 'voice:offer', `${room}: offer relay timed out`);
      second.emit('voice:offer', { target: first.id, description: { type: 'offer', sdp: 'v=0\r\na=vixcord-signaling-test' } });
      if ((await relayedOffer).from !== second.id) throw new Error(`${room}: offer came from the wrong peer.`);
      console.log(`${room}: join, presence, and offer relay passed`);
    }
  } finally {
    first.emit('voice:leave'); second.emit('voice:leave'); first.disconnect(); second.disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
