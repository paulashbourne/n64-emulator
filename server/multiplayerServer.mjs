import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

const HOST = process.env.MULTIPLAYER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MULTIPLAYER_PORT ?? 8787);
const MAX_PLAYERS = 4;
const HOST_RECONNECT_GRACE_MS = 120_000;
const MEMBER_RECONNECT_GRACE_MS = 20_000;
const CHAT_COOLDOWN_MS = 250;
const MAX_CHAT_MESSAGES = 60;
const INVITE_CODE_LENGTH = 6;
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * @typedef {{
 *   clientId: string;
 *   name: string;
 *   slot: number;
 *   isHost: boolean;
 *   connected: boolean;
 *   joinedAt: number;
 *   lastChatAt?: number;
 *   disconnectTimer?: NodeJS.Timeout;
 *   socket?: import('ws').WebSocket;
 * }} SessionMember
 */

/**
 * @typedef {{
 *   code: string;
 *   createdAt: number;
 *   hostClientId: string;
 *   romId?: string;
 *   romTitle?: string;
 *   chat: Array<{
 *     id: string;
 *     fromClientId: string;
 *     fromName: string;
 *     fromSlot: number;
 *     message: string;
 *     at: number;
 *   }>;
 *   hostCloseTimer?: NodeJS.Timeout;
 *   members: Map<string, SessionMember>;
 * }} SessionRecord
 */

/** @type {Map<string, SessionRecord>} */
const sessions = new Map();

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, body) {
  withCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function sanitizeName(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const clean = value.trim().slice(0, 32);
  return clean.length > 0 ? clean : fallback;
}

function sanitizeChatMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function sanitizeWebRtcSignalPayload(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') {
    return null;
  }

  if (payload.kind === 'offer' || payload.kind === 'answer') {
    if (typeof payload.sdp !== 'string') {
      return null;
    }
    const sdp = payload.sdp.slice(0, 200_000);
    if (!sdp) {
      return null;
    }
    return {
      kind: payload.kind,
      sdp,
    };
  }

  if (payload.kind === 'ice_candidate') {
    const candidateInput = payload.candidate;
    if (!candidateInput || typeof candidateInput !== 'object') {
      return null;
    }

    const candidateValue = candidateInput.candidate;
    if (typeof candidateValue !== 'string') {
      return null;
    }

    return {
      kind: 'ice_candidate',
      candidate: {
        candidate: candidateValue.slice(0, 10_000),
        sdpMid: typeof candidateInput.sdpMid === 'string' ? candidateInput.sdpMid : null,
        sdpMLineIndex: Number.isInteger(candidateInput.sdpMLineIndex) ? candidateInput.sdpMLineIndex : null,
        usernameFragment:
          typeof candidateInput.usernameFragment === 'string'
            ? candidateInput.usernameFragment.slice(0, 256)
            : undefined,
      },
    };
  }

  return null;
}

function generateInviteCode() {
  let code = '';
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)];
  }
  return code;
}

function createUniqueInviteCode() {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const code = generateInviteCode();
    if (!sessions.has(code)) {
      return code;
    }
  }
  throw new Error('Unable to generate unique invite code.');
}

function publicMember(member) {
  return {
    clientId: member.clientId,
    name: member.name,
    slot: member.slot,
    isHost: member.isHost,
    connected: member.connected,
    joinedAt: member.joinedAt,
  };
}

function publicSession(session) {
  return {
    code: session.code,
    createdAt: session.createdAt,
    hostClientId: session.hostClientId,
    romId: session.romId,
    romTitle: session.romTitle,
    chat: session.chat,
    members: [...session.members.values()].map(publicMember).sort((left, right) => left.slot - right.slot),
  };
}

function broadcastToConnectedMembers(session, payload) {
  for (const member of session.members.values()) {
    if (!member.socket || member.socket.readyState !== member.socket.OPEN) {
      continue;
    }
    member.socket.send(payload);
  }
}

function broadcastRoomState(session) {
  const payload = JSON.stringify({
    type: 'room_state',
    session: publicSession(session),
  });
  broadcastToConnectedMembers(session, payload);
}

function broadcastChatEntry(session, entry) {
  const payload = JSON.stringify({
    type: 'chat',
    entry,
  });
  broadcastToConnectedMembers(session, payload);
}

function findOpenPlayerSlot(session) {
  const occupiedSlots = new Set([...session.members.values()].map((member) => member.slot));
  for (let slot = 2; slot <= MAX_PLAYERS; slot += 1) {
    if (!occupiedSlots.has(slot)) {
      return slot;
    }
  }
  return null;
}

function parseSessionCodeFromPath(pathname) {
  const match = pathname.match(/^\/api\/multiplayer\/sessions\/([A-Z0-9]{6})(?:\/(join|close|kick))?$/);
  return match ? match[1] : null;
}

function isSessionBasePath(pathname) {
  return /^\/api\/multiplayer\/sessions\/[A-Z0-9]{6}$/.test(pathname);
}

function handleWsMessage(session, member, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    return;
  }

  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'ping') {
    member.socket?.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }

  if (message.type === 'host_rom' && member.isHost) {
    if ('romId' in message) {
      session.romId = typeof message.romId === 'string' ? message.romId : undefined;
    }
    if ('romTitle' in message) {
      session.romTitle = typeof message.romTitle === 'string' ? message.romTitle : undefined;
    }
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'input' && !member.isHost) {
    const hostMember = session.members.get(session.hostClientId);
    if (!hostMember?.socket || hostMember.socket.readyState !== hostMember.socket.OPEN) {
      return;
    }

    hostMember.socket.send(
      JSON.stringify({
        type: 'remote_input',
        fromClientId: member.clientId,
        fromName: member.name,
        fromSlot: member.slot,
        payload: message.payload ?? null,
        at: Date.now(),
      }),
    );
    return;
  }

  if (message.type === 'chat') {
    const text = sanitizeChatMessage(message.text);
    if (!text) {
      return;
    }
    const now = Date.now();
    if (member.lastChatAt && now - member.lastChatAt < CHAT_COOLDOWN_MS) {
      return;
    }
    member.lastChatAt = now;

    const entry = {
      id: randomUUID(),
      fromClientId: member.clientId,
      fromName: member.name,
      fromSlot: member.slot,
      message: text,
      at: now,
    };

    session.chat.push(entry);
    if (session.chat.length > MAX_CHAT_MESSAGES) {
      session.chat.splice(0, session.chat.length - MAX_CHAT_MESSAGES);
    }

    broadcastChatEntry(session, entry);
    return;
  }

  if (message.type === 'webrtc_signal') {
    if (typeof message.targetClientId !== 'string') {
      return;
    }

    const target = session.members.get(message.targetClientId);
    if (!target || !target.socket || target.socket.readyState !== target.socket.OPEN) {
      return;
    }

    // Keep peer topology host<->guest only.
    if (member.isHost === target.isHost) {
      return;
    }

    const payload = sanitizeWebRtcSignalPayload(message.payload);
    if (!payload) {
      return;
    }

    target.socket.send(
      JSON.stringify({
        type: 'webrtc_signal',
        fromClientId: member.clientId,
        fromName: member.name,
        fromSlot: member.slot,
        payload,
        at: Date.now(),
      }),
    );
  }
}

function broadcastSessionClosed(session, reason) {
  const payload = JSON.stringify({
    type: 'session_closed',
    reason,
    at: Date.now(),
  });
  broadcastToConnectedMembers(session, payload);
}

function sendMemberKicked(member, byName, reason) {
  if (!member.socket || member.socket.readyState !== member.socket.OPEN) {
    return;
  }

  member.socket.send(
    JSON.stringify({
      type: 'kicked',
      byName,
      reason,
      at: Date.now(),
    }),
  );
}

function removeMember(session, member, options = {}) {
  const {
    byName = 'Host',
    kickedReason,
    closeSocketReason,
  } = options;

  if (member.disconnectTimer) {
    clearTimeout(member.disconnectTimer);
    member.disconnectTimer = undefined;
  }

  if (kickedReason) {
    sendMemberKicked(member, byName, kickedReason);
  }

  if (member.socket && member.socket.readyState === member.socket.OPEN) {
    member.socket.close(1000, closeSocketReason || 'Removed from session');
  }

  member.connected = false;
  member.socket = undefined;
  session.members.delete(member.clientId);
}

function closeSession(session, options = {}) {
  const {
    notify = false,
    notifyReason = 'Session closed.',
    socketReason = 'Session closed',
  } = options;

  if (notify) {
    broadcastSessionClosed(session, notifyReason);
  }

  if (session.hostCloseTimer) {
    clearTimeout(session.hostCloseTimer);
    session.hostCloseTimer = undefined;
  }

  for (const member of session.members.values()) {
    if (member.disconnectTimer) {
      clearTimeout(member.disconnectTimer);
      member.disconnectTimer = undefined;
    }
    if (member.socket && member.socket.readyState === member.socket.OPEN) {
      member.socket.close(1000, socketReason);
    }
  }
  sessions.delete(session.code);
}

function scheduleSessionCloseIfHostDoesNotReturn(session) {
  if (session.hostCloseTimer) {
    return;
  }

  session.hostCloseTimer = setTimeout(() => {
    if (sessions.has(session.code)) {
      closeSession(session, {
        notify: true,
        notifyReason: 'Host disconnected for too long. Session closed.',
        socketReason: 'Host disconnected',
      });
    }
  }, HOST_RECONNECT_GRACE_MS);
}

function cancelHostCloseTimer(session) {
  if (!session.hostCloseTimer) {
    return;
  }
  clearTimeout(session.hostCloseTimer);
  session.hostCloseTimer = undefined;
}

function scheduleMemberRemovalIfNotReconnected(session, member) {
  if (member.disconnectTimer) {
    return;
  }

  member.disconnectTimer = setTimeout(() => {
    member.disconnectTimer = undefined;
    if (!sessions.has(session.code)) {
      return;
    }
    if (member.socket || member.connected || member.isHost) {
      return;
    }
    session.members.delete(member.clientId);
    broadcastRoomState(session);
  }, MEMBER_RECONNECT_GRACE_MS);
}

function cancelMemberDisconnectTimer(member) {
  if (!member.disconnectTimer) {
    return;
  }
  clearTimeout(member.disconnectTimer);
  member.disconnectTimer = undefined;
}

const httpServer = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const pathname = requestUrl.pathname;

  if (req.method === 'OPTIONS') {
    withCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'multiplayer-coordinator' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/multiplayer/sessions') {
    try {
      const body = await readJsonBody(req);
      const hostName = sanitizeName(body.hostName, 'Host');
      const code = createUniqueInviteCode();
      const hostClientId = randomUUID();
      const createdAt = Date.now();

      /** @type {SessionRecord} */
      const session = {
        code,
        createdAt,
        hostClientId,
        romId: typeof body.romId === 'string' ? body.romId : undefined,
        romTitle: typeof body.romTitle === 'string' ? body.romTitle : undefined,
        chat: [],
        members: new Map(),
      };

      session.members.set(hostClientId, {
        clientId: hostClientId,
        name: hostName,
        slot: 1,
        isHost: true,
        connected: false,
        joinedAt: createdAt,
      });

      sessions.set(code, session);

      sendJson(res, 201, {
        code,
        clientId: hostClientId,
        session: publicSession(session),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid session create payload.';
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/join')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(res, 404, { error: 'Invite code was not found.' });
      return;
    }

    const openSlot = findOpenPlayerSlot(session);
    if (!openSlot) {
      sendJson(res, 409, { error: 'Session is full (maximum 4 players).' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const name = sanitizeName(body.name, `Player ${openSlot}`);
      const clientId = randomUUID();

      session.members.set(clientId, {
        clientId,
        name,
        slot: openSlot,
        isHost: false,
        connected: false,
        joinedAt: Date.now(),
      });

      sendJson(res, 200, {
        code,
        clientId,
        session: publicSession(session),
      });
      broadcastRoomState(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid join payload.';
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/close')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(res, 404, { error: 'Invite code was not found.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      if (clientId !== session.hostClientId) {
        sendJson(res, 403, { error: 'Only the host can close this session.' });
        return;
      }

      closeSession(session, {
        notify: true,
        notifyReason: 'Host ended the session.',
        socketReason: 'Host ended session',
      });
      sendJson(res, 200, {
        closed: true,
        code,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid close payload.';
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/kick')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(res, 404, { error: 'Invite code was not found.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      const targetClientId = typeof body.targetClientId === 'string' ? body.targetClientId : '';
      if (clientId !== session.hostClientId) {
        sendJson(res, 403, { error: 'Only the host can kick players.' });
        return;
      }

      const target = session.members.get(targetClientId);
      if (!target || target.isHost) {
        sendJson(res, 404, { error: 'Kick target was not found.' });
        return;
      }

      const host = session.members.get(session.hostClientId);
      removeMember(session, target, {
        byName: host?.name ?? 'Host',
        kickedReason: 'You were removed by the host.',
        closeSocketReason: 'Kicked by host',
      });
      broadcastRoomState(session);

      sendJson(res, 200, {
        kicked: true,
        code,
        targetClientId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid kick payload.';
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'GET' && isSessionBasePath(pathname)) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(res, 404, { error: 'Invite code was not found.' });
      return;
    }

    sendJson(res, 200, {
      session: publicSession(session),
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
});

const wsServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (requestUrl.pathname !== '/ws/multiplayer') {
    socket.destroy();
    return;
  }

  const code = (requestUrl.searchParams.get('code') ?? '').toUpperCase();
  const clientId = requestUrl.searchParams.get('clientId') ?? '';
  const session = sessions.get(code);
  if (!session) {
    socket.destroy();
    return;
  }

  const member = session.members.get(clientId);
  if (!member) {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(req, socket, head, (ws) => {
    if (member.socket && member.socket !== ws && member.socket.readyState === member.socket.OPEN) {
      member.socket.close(1000, 'Reconnected from another tab');
    }

    member.socket = ws;
    member.connected = true;
    cancelMemberDisconnectTimer(member);
    if (member.isHost) {
      cancelHostCloseTimer(session);
    }

    ws.send(
      JSON.stringify({
        type: 'connected',
        clientId: member.clientId,
        slot: member.slot,
        isHost: member.isHost,
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'room_state',
        session: publicSession(session),
      }),
    );
    broadcastRoomState(session);

    ws.on('message', (rawMessage) => {
      handleWsMessage(session, member, rawMessage);
    });

    ws.on('close', () => {
      if (member.socket !== ws) {
        return;
      }

      if (!sessions.has(session.code)) {
        return;
      }

      if (member.isHost) {
        member.connected = false;
        member.socket = undefined;
        cancelMemberDisconnectTimer(member);
        broadcastRoomState(session);
        scheduleSessionCloseIfHostDoesNotReturn(session);
        return;
      }

      member.connected = false;
      member.socket = undefined;
      broadcastRoomState(session);
      scheduleMemberRemovalIfNotReconnected(session, member);
    });
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Multiplayer coordinator listening at http://${HOST}:${PORT}`);
});
