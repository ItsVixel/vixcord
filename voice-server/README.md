# Vixcord voice server

This folder contains the Socket.IO signaling and presence server used by the two WebRTC voice channels in `vixcord-enhanced.html`. Audio travels directly between browsers through WebRTC; the server never stores or relays voice audio.

## Install and run

Open PowerShell and run:

```powershell
cd "C:\Users\abdal\Documents\Codex\2026-07-25\make-when-it-reaches-90-messages\outputs\voice-server"
npm install
npm start
```

The production deployment is available at:

```text
https://vixcord.onrender.com
```

Open Vixcord through the HTTPS Render URL so browsers can grant microphone access securely.

## Voice server setting

The frontend setting is near the top of the JavaScript in `vixcord-enhanced.html`:

```js
const VOICE_SERVER_URL='https://vixcord.onrender.com';
```

The Render deployment is now the production default. Keep this as an HTTPS URL so browsers permit microphone access and do not block mixed content.

## Test both rooms

1. Open `https://vixcord.onrender.com` in two different browser profiles or one normal window and one private window.
2. Sign into two different Vixcord accounts.
3. Join **General Voice** from both windows, permit microphone access, and use headphones to avoid feedback.
4. Confirm both names appear beneath the channel and that each browser hears the other.
5. Leave from one window and confirm the other remains connected.
6. Join **General Voice 2** and repeat. Switching rooms automatically leaves the previous room.

## Limits of this simple mesh setup

- Every participant connects directly to every other participant, so this is best for small rooms.
- Public STUN servers are configured, but there is no TURN relay. Some strict firewalls or NAT combinations may prevent peer-to-peer audio.
- Voice presence is temporary and resets when the Node server restarts. No voice presence or audio is written to MockAPI.
- Remote use requires a trusted HTTPS origin for reliable browser microphone permission.
