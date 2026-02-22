import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

const HOST = process.env.MULTIPLAYER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MULTIPLAYER_PORT ?? 8787);
const MAX_PLAYERS = 4;
const HOST_RECONNECT_GRACE_MS = 120_000;
const MEMBER_RECONNECT_GRACE_MS = 20_000;
const CHAT_COOLDOWN_MS = 250;
const STREAM_RESYNC_COOLDOWN_MS = 1_000;
const MAX_CHAT_MESSAGES = 60;
const INVITE_CODE_LENGTH = 6;
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONTROLLER_PROFILE_STORE_PATH =
  process.env.MULTIPLAYER_PROFILE_STORE_PATH ?? './.runtime/controller-profiles.json';
const CONTROLLER_PROFILE_TARGETS = [
  'a',
  'b',
  'z',
  'start',
  'l',
  'r',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'c_up',
  'c_down',
  'c_left',
  'c_right',
  'analog_left',
  'analog_right',
  'analog_up',
  'analog_down',
];
const CONTROLLER_PROFILE_TARGET_SET = new Set(CONTROLLER_PROFILE_TARGETS);
const INPUT_SOURCES = new Set(['keyboard', 'gamepad_button', 'gamepad_axis']);

/**
 * @typedef {{
 *   clientId: string;
 *   name: string;
 *   avatarUrl?: string;
 *   slot: number;
 *   isHost: boolean;
 *   connected: boolean;
 *   ready: boolean;
 *   pingMs?: number;
 *   joinedAt: number;
 *   lastChatAt?: number;
 *   lastStreamResyncAt?: number;
 *   lastLatencyBroadcastAt?: number;
 *   disconnectTimer?: NodeJS.Timeout;
 *   socket?: import('ws').WebSocket;
 * }} SessionMember
 */

/**
 * @typedef {{
 *   code: string;
 *   createdAt: number;
 *   hostClientId: string;
 *   joinLocked: boolean;
 *   voiceEnabled: boolean;
 *   mutedInputClientIds: Set<string>;
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

/**
 * @typedef {{
 *   profileId: string;
 *   name: string;
 *   deviceId: string;
 *   deadzone: number;
 *   bindings: Record<string, {
 *     source: 'keyboard' | 'gamepad_button' | 'gamepad_axis';
 *     code?: string;
 *     index?: number;
 *     gamepadIndex?: number;
 *     deviceId?: string;
 *     direction?: 'negative' | 'positive';
 *     threshold?: number;
 *     axisValue?: number;
 *     axisTolerance?: number;
 *   }>;
 *   updatedAt: number;
 * }} SharedControllerProfile
 */

/** @type {Map<string, SessionRecord>} */
const sessions = new Map();
/** @type {Map<string, SharedControllerProfile>} */
const sharedControllerProfiles = new Map();
let profileStoreWritePromise = Promise.resolve();

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeControllerBinding(rawBinding) {
  if (!rawBinding || typeof rawBinding !== 'object' || !INPUT_SOURCES.has(rawBinding.source)) {
    return null;
  }

  /** @type {SharedControllerProfile['bindings'][string]} */
  const sanitized = {
    source: rawBinding.source,
  };

  if (typeof rawBinding.index === 'number' && Number.isInteger(rawBinding.index) && rawBinding.index >= 0) {
    sanitized.index = rawBinding.index;
  }
  if (typeof rawBinding.gamepadIndex === 'number' && Number.isInteger(rawBinding.gamepadIndex) && rawBinding.gamepadIndex >= 0) {
    sanitized.gamepadIndex = rawBinding.gamepadIndex;
  }
  if (typeof rawBinding.deviceId === 'string') {
    const deviceId = rawBinding.deviceId.trim().slice(0, 200);
    if (deviceId) {
      sanitized.deviceId = deviceId;
    }
  }

  if (rawBinding.source === 'keyboard') {
    if (typeof rawBinding.code !== 'string') {
      return null;
    }
    const code = rawBinding.code.trim().slice(0, 64);
    if (!code) {
      return null;
    }
    sanitized.code = code;
    return sanitized;
  }

  if (rawBinding.source === 'gamepad_button') {
    if (sanitized.index === undefined) {
      return null;
    }
    return sanitized;
  }

  if (sanitized.index === undefined) {
    return null;
  }

  if (typeof rawBinding.axisValue === 'number' && Number.isFinite(rawBinding.axisValue)) {
    sanitized.axisValue = clamp(rawBinding.axisValue, -1, 1);
    if (typeof rawBinding.axisTolerance === 'number' && Number.isFinite(rawBinding.axisTolerance)) {
      sanitized.axisTolerance = clamp(rawBinding.axisTolerance, 0.01, 0.5);
    }
    return sanitized;
  }

  if (rawBinding.direction === 'negative' || rawBinding.direction === 'positive') {
    sanitized.direction = rawBinding.direction;
  } else {
    return null;
  }
  if (typeof rawBinding.threshold === 'number' && Number.isFinite(rawBinding.threshold)) {
    sanitized.threshold = clamp(rawBinding.threshold, 0, 0.95);
  }
  return sanitized;
}

function sanitizeControllerProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object') {
    return null;
  }

  const profileId = typeof rawProfile.profileId === 'string' ? rawProfile.profileId.trim().slice(0, 128) : '';
  if (!profileId) {
    return null;
  }

  const nameInput = typeof rawProfile.name === 'string' ? rawProfile.name : '';
  const deviceInput = typeof rawProfile.deviceId === 'string' ? rawProfile.deviceId : '';
  const rawDeadzone = typeof rawProfile.deadzone === 'number' && Number.isFinite(rawProfile.deadzone) ? rawProfile.deadzone : 0.2;
  const updatedAt = typeof rawProfile.updatedAt === 'number' && Number.isFinite(rawProfile.updatedAt)
    ? Math.round(rawProfile.updatedAt)
    : Date.now();

  /** @type {SharedControllerProfile['bindings']} */
  const bindings = {};
  const rawBindings = rawProfile.bindings && typeof rawProfile.bindings === 'object' ? rawProfile.bindings : {};
  for (const [target, rawBinding] of Object.entries(rawBindings)) {
    if (!CONTROLLER_PROFILE_TARGET_SET.has(target)) {
      continue;
    }
    const sanitizedBinding = sanitizeControllerBinding(rawBinding);
    if (!sanitizedBinding) {
      continue;
    }
    bindings[target] = sanitizedBinding;
  }

  return {
    profileId,
    name: sanitizeName(nameInput, 'Controller Profile'),
    deviceId: sanitizeName(deviceInput, 'gamepad-generic'),
    deadzone: clamp(rawDeadzone, 0, 0.95),
    bindings,
    updatedAt,
  };
}

function listSharedProfiles() {
  return [...sharedControllerProfiles.values()].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.profileId.localeCompare(right.profileId);
  });
}

async function persistSharedProfilesToDisk() {
  const directory = dirname(CONTROLLER_PROFILE_STORE_PATH);
  const payload = JSON.stringify(
    {
      updatedAt: Date.now(),
      profiles: listSharedProfiles(),
    },
    null,
    2,
  );

  await mkdir(directory, { recursive: true });
  await writeFile(CONTROLLER_PROFILE_STORE_PATH, payload, 'utf8');
}

async function queueProfilePersist() {
  profileStoreWritePromise = profileStoreWritePromise
    .then(() => persistSharedProfilesToDisk())
    .catch((error) => {
      console.error(`Failed to persist controller profiles at ${CONTROLLER_PROFILE_STORE_PATH}:`, error);
    });
  await profileStoreWritePromise;
}

async function loadSharedProfilesFromDisk() {
  try {
    const raw = await readFile(CONTROLLER_PROFILE_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    for (const rawProfile of profiles) {
      const sanitized = sanitizeControllerProfile(rawProfile);
      if (!sanitized) {
        continue;
      }
      sharedControllerProfiles.set(sanitized.profileId, sanitized);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    console.error('Unable to load shared controller profiles:', error);
  }
}

function parseControllerProfileId(pathname) {
  const match = pathname.match(/^\/api\/controller-profiles\/(.+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function sanitizeName(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const clean = value.trim().slice(0, 32);
  return clean.length > 0 ? clean : fallback;
}

function sanitizeAvatarUrl(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const clean = value.trim().slice(0, 500);
  if (!clean) {
    return undefined;
  }

  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('data:image/')) {
    return clean;
  }

  return undefined;
}

function sanitizeChatMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function sanitizeQualityHintReason(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
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
    avatarUrl: member.avatarUrl,
    slot: member.slot,
    isHost: member.isHost,
    connected: member.connected,
    ready: member.ready,
    pingMs: member.pingMs,
    joinedAt: member.joinedAt,
  };
}

function publicSession(session) {
  return {
    code: session.code,
    createdAt: session.createdAt,
    hostClientId: session.hostClientId,
    joinLocked: session.joinLocked,
    voiceEnabled: Boolean(session.voiceEnabled),
    mutedInputClientIds: [...session.mutedInputClientIds.values()],
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

function broadcastMemberLatency(session, member) {
  const payload = JSON.stringify({
    type: 'member_latency',
    clientId: member.clientId,
    pingMs: member.pingMs,
    at: Date.now(),
  });
  broadcastToConnectedMembers(session, payload);
}

function sendRemoteInputResetToHost(session, sourceMember, reason) {
  if (sourceMember.isHost) {
    return;
  }

  const hostMember = session.members.get(session.hostClientId);
  if (!hostMember?.socket || hostMember.socket.readyState !== hostMember.socket.OPEN) {
    return;
  }

  hostMember.socket.send(
    JSON.stringify({
      type: 'remote_input_reset',
      fromClientId: sourceMember.clientId,
      fromName: sourceMember.name,
      fromSlot: sourceMember.slot,
      reason,
      at: Date.now(),
    }),
  );
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

function findMemberBySlot(session, slot) {
  for (const sessionMember of session.members.values()) {
    if (sessionMember.slot === slot) {
      return sessionMember;
    }
  }
  return undefined;
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
    const sentAt = Number(message.sentAt);
    if (Number.isFinite(sentAt)) {
      const pingMs = Math.max(1, Math.min(2_000, Date.now() - sentAt));
      const previousPing = member.pingMs;
      member.pingMs = pingMs;
      const latencyDelta = previousPing === undefined ? pingMs : Math.abs(previousPing - pingMs);
      if (previousPing === undefined || latencyDelta >= 12 || Date.now() - (member.lastLatencyBroadcastAt ?? 0) > 8_000) {
        member.lastLatencyBroadcastAt = Date.now();
        broadcastMemberLatency(session, member);
      }
    }

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
    for (const sessionMember of session.members.values()) {
      sessionMember.ready = false;
    }
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'set_ready') {
    member.ready = Boolean(message.ready);
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'set_join_lock' && member.isHost) {
    session.joinLocked = Boolean(message.locked);
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'set_voice_enabled' && member.isHost) {
    session.voiceEnabled = Boolean(message.enabled);
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'set_input_mute' && member.isHost) {
    const targetClientId = typeof message.targetClientId === 'string' ? message.targetClientId : '';
    const muted = Boolean(message.muted);
    if (!targetClientId) {
      return;
    }

    const targetMember = session.members.get(targetClientId);
    if (!targetMember || targetMember.isHost) {
      return;
    }

    if (muted) {
      if (!session.mutedInputClientIds.has(targetClientId)) {
        sendRemoteInputResetToHost(session, targetMember, 'muted');
      }
      session.mutedInputClientIds.add(targetClientId);
    } else {
      session.mutedInputClientIds.delete(targetClientId);
    }
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'set_slot' && member.isHost) {
    const targetClientId = typeof message.targetClientId === 'string' ? message.targetClientId : '';
    const requestedSlot = Number(message.slot);
    if (!targetClientId || !Number.isInteger(requestedSlot) || requestedSlot < 2 || requestedSlot > MAX_PLAYERS) {
      return;
    }

    const targetMember = session.members.get(targetClientId);
    if (!targetMember || targetMember.isHost) {
      return;
    }

    const originalSlot = targetMember.slot;
    if (originalSlot === requestedSlot) {
      return;
    }

    const occupant = findMemberBySlot(session, requestedSlot);
    if (occupant && occupant.clientId !== targetMember.clientId) {
      if (occupant.isHost) {
        return;
      }
      sendRemoteInputResetToHost(session, occupant, 'slot_changed');
      occupant.slot = originalSlot;
      occupant.ready = false;
    }

    sendRemoteInputResetToHost(session, targetMember, 'slot_changed');
    targetMember.slot = requestedSlot;
    targetMember.ready = false;
    broadcastRoomState(session);
    return;
  }

  if (message.type === 'input' && !member.isHost) {
    const hostMember = session.members.get(session.hostClientId);
    if (!hostMember?.socket || hostMember.socket.readyState !== hostMember.socket.OPEN) {
      return;
    }

    if (session.mutedInputClientIds.has(member.clientId)) {
      hostMember.socket.send(
        JSON.stringify({
          type: 'input_blocked',
          fromClientId: member.clientId,
          fromName: member.name,
          fromSlot: member.slot,
          payload: message.payload ?? null,
          at: Date.now(),
        }),
      );
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

  if (message.type === 'quality_hint' && !member.isHost) {
    const hostMember = session.members.get(session.hostClientId);
    if (!hostMember?.socket || hostMember.socket.readyState !== hostMember.socket.OPEN) {
      return;
    }

    const requestedPreset =
      message.requestedPreset === 'ultra_low_latency' ||
      message.requestedPreset === 'balanced' ||
      message.requestedPreset === 'quality'
        ? message.requestedPreset
        : null;
    if (!requestedPreset) {
      return;
    }

    const reason = sanitizeQualityHintReason(message.reason);

    hostMember.socket.send(
      JSON.stringify({
        type: 'quality_hint',
        fromClientId: member.clientId,
        fromName: member.name,
        fromSlot: member.slot,
        requestedPreset,
        reason: reason || undefined,
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
    return;
  }

  if (message.type === 'stream_resync_request' && !member.isHost) {
    const now = Date.now();
    if (member.lastStreamResyncAt && now - member.lastStreamResyncAt < STREAM_RESYNC_COOLDOWN_MS) {
      return;
    }
    member.lastStreamResyncAt = now;

    const hostMember = session.members.get(session.hostClientId);
    if (!hostMember?.socket || hostMember.socket.readyState !== hostMember.socket.OPEN) {
      return;
    }

    hostMember.socket.send(
      JSON.stringify({
        type: 'stream_resync_request',
        fromClientId: member.clientId,
        fromName: member.name,
        fromSlot: member.slot,
        at: now,
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

  sendRemoteInputResetToHost(session, member, 'member_removed');

  if (kickedReason) {
    sendMemberKicked(member, byName, kickedReason);
  }

  if (member.socket && member.socket.readyState === member.socket.OPEN) {
    member.socket.close(1000, closeSocketReason || 'Removed from session');
  }

  member.connected = false;
  member.socket = undefined;
  session.mutedInputClientIds.delete(member.clientId);
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
    session.mutedInputClientIds.delete(member.clientId);
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

  if (req.method === 'GET' && pathname === '/api/controller-profiles') {
    sendJson(res, 200, { profiles: listSharedProfiles() });
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/controller-profiles') {
    try {
      const body = await readJsonBody(req);
      const rawProfiles = Array.isArray(body?.profiles)
        ? body.profiles
        : body?.profile
          ? [body.profile]
          : [];

      let updated = 0;
      for (const rawProfile of rawProfiles) {
        const profile = sanitizeControllerProfile(rawProfile);
        if (!profile) {
          continue;
        }

        const existing = sharedControllerProfiles.get(profile.profileId);
        if (!existing || profile.updatedAt >= existing.updatedAt) {
          sharedControllerProfiles.set(profile.profileId, profile);
          updated += 1;
        }
      }

      if (updated > 0) {
        await queueProfilePersist();
      }

      sendJson(res, 200, { profiles: listSharedProfiles(), updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid profile payload.';
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/controller-profiles/')) {
    const profileId = parseControllerProfileId(pathname);
    if (!profileId) {
      sendJson(res, 400, { error: 'Invalid profile id.' });
      return;
    }

    const deleted = sharedControllerProfiles.delete(profileId);
    if (deleted) {
      await queueProfilePersist();
    }

    sendJson(res, 200, { deleted });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/multiplayer/sessions') {
    try {
      const body = await readJsonBody(req);
      const hostName = sanitizeName(body.hostName, 'Host');
      const hostAvatarUrl = sanitizeAvatarUrl(body.avatarUrl);
      const initialVoiceEnabled = typeof body.voiceEnabled === 'boolean' ? body.voiceEnabled : true;
      const code = createUniqueInviteCode();
      const hostClientId = randomUUID();
      const createdAt = Date.now();

      /** @type {SessionRecord} */
      const session = {
        code,
        createdAt,
        hostClientId,
        joinLocked: false,
        voiceEnabled: initialVoiceEnabled,
        mutedInputClientIds: new Set(),
        romId: typeof body.romId === 'string' ? body.romId : undefined,
        romTitle: typeof body.romTitle === 'string' ? body.romTitle : undefined,
        chat: [],
        members: new Map(),
      };

      session.members.set(hostClientId, {
        clientId: hostClientId,
        name: hostName,
        avatarUrl: hostAvatarUrl,
        slot: 1,
        isHost: true,
        connected: false,
        ready: false,
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

    if (session.joinLocked) {
      sendJson(res, 423, { error: 'This room is locked by the host. Ask the host to unlock joins.' });
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
      const avatarUrl = sanitizeAvatarUrl(body.avatarUrl);
      const clientId = randomUUID();

      session.members.set(clientId, {
        clientId,
        name,
        avatarUrl,
        slot: openSlot,
        isHost: false,
        connected: false,
        ready: false,
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

  try {
    socket.setNoDelay(true);
  } catch {
    // Keep upgrade flow running on platforms where noDelay is unavailable.
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

      sendRemoteInputResetToHost(session, member, 'member_disconnected');
      member.connected = false;
      member.socket = undefined;
      broadcastRoomState(session);
      scheduleMemberRemovalIfNotReconnected(session, member);
    });
  });
});

await loadSharedProfilesFromDisk();
console.log(`Loaded ${sharedControllerProfiles.size} shared controller profile(s) from ${CONTROLLER_PROFILE_STORE_PATH}.`);

httpServer.listen(PORT, HOST, () => {
  console.log(`Multiplayer coordinator listening at http://${HOST}:${PORT}`);
});
