import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
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
const AUTH_USER_STORE_PATH = process.env.AUTH_USER_STORE_PATH ?? './.runtime/users.json';
const AUTH_SESSION_STORE_PATH = process.env.AUTH_SESSION_STORE_PATH ?? './.runtime/sessions.json';
const CLOUD_SAVE_STORE_PATH = process.env.CLOUD_SAVE_STORE_PATH ?? './.runtime/cloud-saves.json';
const AUTH_AVATAR_DIR = process.env.AUTH_AVATAR_DIR ?? './.runtime/avatars';
const AUTH_SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS ?? 2_592_000_000);
const AUTH_PASSWORD_MIN_LENGTH = Number(process.env.AUTH_PASSWORD_MIN_LENGTH ?? 8);
const AUTH_SESSION_COOKIE = 'wd64_session';
const AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 20;
const EDGE_AUTH_COOKIE_NAME = (process.env.BASIC_AUTH_EDGE_COOKIE_NAME ?? '').trim();
const EDGE_AUTH_COOKIE_TOKEN = (process.env.BASIC_AUTH_EDGE_COOKIE_TOKEN ?? '').trim();
const EDGE_AUTH_COOKIE_MAX_AGE_SECONDS = Number(process.env.BASIC_AUTH_EDGE_COOKIE_MAX_AGE_SECONDS ?? 31_536_000);
const MAX_AVATAR_BYTES = 256 * 1024;
const ALLOWED_AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_MIME_EXTENSION = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
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
 *   userId: string;
 *   username: string;
 *   usernameLower: string;
 *   email: string;
 *   emailLower: string;
 *   country: string;
 *   avatarId?: string;
 *   passwordSaltHex: string;
 *   passwordHashHex: string;
 *   passwordN: number;
 *   passwordR: number;
 *   passwordP: number;
 *   createdAt: number;
 *   updatedAt: number;
 * }} AuthUserRecord
 */

/**
 * @typedef {{
 *   sessionId: string;
 *   userId: string;
 *   createdAt: number;
 *   expiresAt: number;
 *   lastSeenAt: number;
 * }} AuthSessionRecord
 */

/**
 * @typedef {{
 *   key: string;
 *   userId: string;
 *   romHash: string;
 *   slotId: string;
 *   gameKey?: string;
 *   gameTitle?: string;
 *   slotName?: string;
 *   updatedAt: number;
 *   byteLength: number;
 *   dataBase64: string;
 * }} CloudSaveRecord
 */

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
/** @type {Map<string, AuthUserRecord>} */
const authUsersById = new Map();
/** @type {Map<string, string>} */
const authUserIdByUsernameLower = new Map();
/** @type {Map<string, string>} */
const authUserIdByEmailLower = new Map();
/** @type {Map<string, AuthSessionRecord>} */
const authSessions = new Map();
/** @type {Map<string, CloudSaveRecord>} */
const cloudSavesByKey = new Map();
/** @type {Map<string, { windowStartedAt: number; attempts: number }>} */
const authRateLimits = new Map();
let profileStoreWritePromise = Promise.resolve();
let authUserStoreWritePromise = Promise.resolve();
let authSessionStoreWritePromise = Promise.resolve();
let cloudSaveStoreWritePromise = Promise.resolve();

function resolveCorsOrigin(req) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!origin) {
    return '*';
  }
  return origin;
}

function withCors(req, res) {
  const origin = resolveCorsOrigin(req);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(req, res, statusCode, body) {
  withCors(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function normalizeSessionTtlMs() {
  const rounded = Math.round(AUTH_SESSION_TTL_MS);
  if (!Number.isFinite(rounded)) {
    return 2_592_000_000;
  }
  return Math.max(60_000, rounded);
}

function now() {
  return Date.now();
}

function cleanAuthRateLimitCache() {
  const current = now();
  for (const [key, entry] of authRateLimits.entries()) {
    if (current - entry.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS) {
      authRateLimits.delete(key);
    }
  }
}

function requestClientIp(req) {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first.slice(0, 128);
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function authRateLimitExceeded(req, action, usernameLower) {
  cleanAuthRateLimitCache();
  const key = `${action}:${requestClientIp(req)}:${usernameLower || '-'}`;
  const current = now();
  const existing = authRateLimits.get(key);
  if (!existing || current - existing.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    authRateLimits.set(key, {
      windowStartedAt: current,
      attempts: 1,
    });
    return false;
  }
  existing.attempts += 1;
  authRateLimits.set(key, existing);
  return existing.attempts > AUTH_RATE_LIMIT_MAX_ATTEMPTS;
}

function parseCookies(req) {
  const header = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  if (!header) {
    return new Map();
  }
  const result = new Map();
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!key) {
      continue;
    }
    try {
      result.set(key, decodeURIComponent(value));
    } catch {
      result.set(key, value);
    }
  }
  return result;
}

function shouldUseSecureCookie(req) {
  if (req.socket.encrypted) {
    return true;
  }
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].toLowerCase()
    : '';
  if (forwardedProto.includes('https')) {
    return true;
  }
  const cloudfrontForwardedProto = typeof req.headers['cloudfront-forwarded-proto'] === 'string'
    ? req.headers['cloudfront-forwarded-proto'].toLowerCase()
    : '';
  return cloudfrontForwardedProto.includes('https');
}

function appendSetCookieHeader(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), cookie]);
}

function setEdgePasswordGateCookie(req, res) {
  if (!EDGE_AUTH_COOKIE_NAME || !EDGE_AUTH_COOKIE_TOKEN) {
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(EDGE_AUTH_COOKIE_NAME)) {
    return;
  }
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(EDGE_AUTH_COOKIE_TOKEN)) {
    return;
  }

  const configuredMaxAge = Number.isFinite(EDGE_AUTH_COOKIE_MAX_AGE_SECONDS)
    ? Math.floor(EDGE_AUTH_COOKIE_MAX_AGE_SECONDS)
    : 31_536_000;
  const maxAge = Math.max(60, Math.min(31_536_000, configuredMaxAge));
  const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
  appendSetCookieHeader(
    res,
    `${EDGE_AUTH_COOKIE_NAME}=${EDGE_AUTH_COOKIE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function setAuthCookie(req, res, sessionId, expiresAt) {
  const ttlMs = Math.max(0, expiresAt - now());
  const maxAge = Math.floor(ttlMs / 1000);
  const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
  const value = encodeURIComponent(sessionId);
  appendSetCookieHeader(
    res,
    `${AUTH_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
  setEdgePasswordGateCookie(req, res);
}

function clearAuthCookie(req, res) {
  const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
  appendSetCookieHeader(
    res,
    `${AUTH_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function normalizeUsername(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 32);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, 254);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUsername(username) {
  return /^[A-Za-z0-9_-]{3,32}$/.test(username);
}

function normalizeCountry(country) {
  if (typeof country !== 'string') {
    return 'Unknown';
  }
  const normalized = country.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }
  return 'Unknown';
}

function inferCountryFromAcceptLanguage(headerValue) {
  if (typeof headerValue !== 'string') {
    return undefined;
  }
  const first = headerValue.split(',')[0]?.trim();
  if (!first) {
    return undefined;
  }
  const match = first.match(/[-_]([A-Za-z]{2}|\d{3})$/);
  if (!match) {
    return undefined;
  }
  return normalizeCountry(match[1]);
}

function detectCountry(req) {
  const viewerCountry = normalizeCountry(String(req.headers['cloudfront-viewer-country'] ?? ''));
  if (viewerCountry !== 'Unknown') {
    return viewerCountry;
  }
  const cfIpCountry = normalizeCountry(String(req.headers['cf-ipcountry'] ?? ''));
  if (cfIpCountry !== 'Unknown') {
    return cfIpCountry;
  }
  const acceptLanguageCountry = inferCountryFromAcceptLanguage(req.headers['accept-language']);
  if (acceptLanguageCountry && acceptLanguageCountry !== 'Unknown') {
    return acceptLanguageCountry;
  }
  return 'Unknown';
}

function userForClient(user) {
  return {
    userId: user.userId,
    username: user.username,
    email: user.email,
    country: user.country,
    avatarUrl: user.avatarId ? `/api/avatars/${encodeURIComponent(user.avatarId)}` : null,
  };
}

function hashPassword(password, saltHex, options = { N: 16384, r: 8, p: 1 }) {
  const salt = Buffer.from(saltHex, 'hex');
  const derived = scryptSync(password, salt, 64, options);
  return {
    passwordHashHex: derived.toString('hex'),
    passwordN: options.N,
    passwordR: options.r,
    passwordP: options.p,
  };
}

function verifyPassword(password, user) {
  try {
    const salt = Buffer.from(user.passwordSaltHex, 'hex');
    const expected = Buffer.from(user.passwordHashHex, 'hex');
    const derived = scryptSync(password, salt, expected.length, {
      N: user.passwordN || 16384,
      r: user.passwordR || 8,
      p: user.passwordP || 1,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function sessionRecordValid(record) {
  return (
    record &&
    typeof record === 'object' &&
    typeof record.sessionId === 'string' &&
    typeof record.userId === 'string' &&
    typeof record.expiresAt === 'number' &&
    record.expiresAt > now()
  );
}

function getAuthSession(req) {
  const sessionId = parseCookies(req).get(AUTH_SESSION_COOKIE);
  if (!sessionId) {
    return null;
  }
  const session = authSessions.get(sessionId);
  if (!session || session.expiresAt <= now()) {
    if (session) {
      authSessions.delete(sessionId);
      void queueAuthSessionPersist();
    }
    return null;
  }
  return session;
}

function getAuthenticatedUser(req) {
  const session = getAuthSession(req);
  if (!session) {
    return null;
  }
  const user = authUsersById.get(session.userId);
  if (!user) {
    authSessions.delete(session.sessionId);
    void queueAuthSessionPersist();
    return null;
  }
  return {
    user,
    session,
  };
}

function parseAvatarIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/avatars\/([A-Za-z0-9._-]+)$/);
  if (!match) {
    return null;
  }
  const avatarId = match[1];
  if (!/^[A-Za-z0-9-]+\.(png|jpg|webp|gif)$/.test(avatarId)) {
    return null;
  }
  return avatarId;
}

function avatarMimeTypeFromFileName(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  return 'application/octet-stream';
}

async function removeAvatarFile(avatarId) {
  if (!avatarId) {
    return;
  }
  const safeName = basename(avatarId);
  if (safeName !== avatarId) {
    return;
  }
  try {
    await unlink(join(AUTH_AVATAR_DIR, safeName));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    console.warn(`Failed to remove avatar file ${safeName}:`, error);
  }
}

function normalizeCloudSaveIdentity(romHash, slotId) {
  const normalizedRomHash = typeof romHash === 'string' ? romHash.trim().toLowerCase().slice(0, 128) : '';
  const normalizedSlotId = typeof slotId === 'string' ? slotId.trim().slice(0, 128) : '';
  if (!normalizedRomHash || !normalizedSlotId) {
    return null;
  }
  return {
    romHash: normalizedRomHash,
    slotId: normalizedSlotId,
  };
}

function cloudSaveKey(userId, romHash, slotId) {
  return `${userId}:${romHash}:${slotId}`;
}

function cloudSaveForClient(record, includeDataBase64 = false) {
  const base = {
    romHash: record.romHash,
    slotId: record.slotId,
    gameKey: record.gameKey,
    gameTitle: record.gameTitle,
    slotName: record.slotName,
    updatedAt: record.updatedAt,
    byteLength: record.byteLength,
  };
  if (includeDataBase64) {
    return {
      ...base,
      dataBase64: record.dataBase64,
    };
  }
  return base;
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

async function persistUsersToDisk() {
  const directory = dirname(AUTH_USER_STORE_PATH);
  const payload = JSON.stringify(
    {
      updatedAt: now(),
      users: [...authUsersById.values()],
    },
    null,
    2,
  );

  await mkdir(directory, { recursive: true });
  await writeFile(AUTH_USER_STORE_PATH, payload, 'utf8');
}

async function queueAuthUserPersist() {
  authUserStoreWritePromise = authUserStoreWritePromise
    .then(() => persistUsersToDisk())
    .catch((error) => {
      console.error(`Failed to persist auth users at ${AUTH_USER_STORE_PATH}:`, error);
    });
  await authUserStoreWritePromise;
}

function resetUserIndexes() {
  authUserIdByUsernameLower.clear();
  authUserIdByEmailLower.clear();
  for (const user of authUsersById.values()) {
    authUserIdByUsernameLower.set(user.usernameLower, user.userId);
    authUserIdByEmailLower.set(user.emailLower, user.userId);
  }
}

function sanitizeLoadedUserRecord(rawUser) {
  if (!rawUser || typeof rawUser !== 'object') {
    return null;
  }

  const userId = typeof rawUser.userId === 'string' ? rawUser.userId.trim() : '';
  const username = normalizeUsername(rawUser.username);
  const email = normalizeEmail(rawUser.email);
  const country = normalizeCountry(rawUser.country);
  const passwordSaltHex = typeof rawUser.passwordSaltHex === 'string' ? rawUser.passwordSaltHex.trim().toLowerCase() : '';
  const passwordHashHex = typeof rawUser.passwordHashHex === 'string' ? rawUser.passwordHashHex.trim().toLowerCase() : '';
  const createdAt = typeof rawUser.createdAt === 'number' ? Math.round(rawUser.createdAt) : now();
  const updatedAt = typeof rawUser.updatedAt === 'number' ? Math.round(rawUser.updatedAt) : createdAt;
  const avatarId = typeof rawUser.avatarId === 'string' ? basename(rawUser.avatarId.trim()) : undefined;
  const passwordN = typeof rawUser.passwordN === 'number' ? Math.round(rawUser.passwordN) : 16384;
  const passwordR = typeof rawUser.passwordR === 'number' ? Math.round(rawUser.passwordR) : 8;
  const passwordP = typeof rawUser.passwordP === 'number' ? Math.round(rawUser.passwordP) : 1;
  if (!userId || !isValidUsername(username) || !isValidEmail(email)) {
    return null;
  }
  if (!/^[a-f0-9]+$/.test(passwordSaltHex) || !/^[a-f0-9]+$/.test(passwordHashHex)) {
    return null;
  }
  return {
    userId,
    username,
    usernameLower: username.toLowerCase(),
    email,
    emailLower: email.toLowerCase(),
    country,
    avatarId: avatarId && /^[A-Za-z0-9-]+\.(png|jpg|webp|gif)$/.test(avatarId) ? avatarId : undefined,
    passwordSaltHex,
    passwordHashHex,
    passwordN,
    passwordR,
    passwordP,
    createdAt,
    updatedAt,
  };
}

async function loadUsersFromDisk() {
  try {
    const raw = await readFile(AUTH_USER_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    for (const rawUser of users) {
      const sanitized = sanitizeLoadedUserRecord(rawUser);
      if (!sanitized) {
        continue;
      }
      authUsersById.set(sanitized.userId, sanitized);
    }
    resetUserIndexes();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    console.error('Unable to load auth users:', error);
  }
}

async function persistAuthSessionsToDisk() {
  const directory = dirname(AUTH_SESSION_STORE_PATH);
  const payload = JSON.stringify(
    {
      updatedAt: now(),
      sessions: [...authSessions.values()],
    },
    null,
    2,
  );

  await mkdir(directory, { recursive: true });
  await writeFile(AUTH_SESSION_STORE_PATH, payload, 'utf8');
}

async function queueAuthSessionPersist() {
  authSessionStoreWritePromise = authSessionStoreWritePromise
    .then(() => persistAuthSessionsToDisk())
    .catch((error) => {
      console.error(`Failed to persist auth sessions at ${AUTH_SESSION_STORE_PATH}:`, error);
    });
  await authSessionStoreWritePromise;
}

async function loadAuthSessionsFromDisk() {
  try {
    const raw = await readFile(AUTH_SESSION_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    for (const rawSession of sessions) {
      if (!sessionRecordValid(rawSession)) {
        continue;
      }
      authSessions.set(rawSession.sessionId, {
        sessionId: rawSession.sessionId,
        userId: rawSession.userId,
        createdAt: Math.round(rawSession.createdAt ?? now()),
        expiresAt: Math.round(rawSession.expiresAt),
        lastSeenAt: Math.round(rawSession.lastSeenAt ?? now()),
      });
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    console.error('Unable to load auth sessions:', error);
  }
}

async function persistCloudSavesToDisk() {
  const directory = dirname(CLOUD_SAVE_STORE_PATH);
  const payload = JSON.stringify(
    {
      updatedAt: now(),
      saves: [...cloudSavesByKey.values()],
    },
    null,
    2,
  );

  await mkdir(directory, { recursive: true });
  await writeFile(CLOUD_SAVE_STORE_PATH, payload, 'utf8');
}

async function queueCloudSavePersist() {
  cloudSaveStoreWritePromise = cloudSaveStoreWritePromise
    .then(() => persistCloudSavesToDisk())
    .catch((error) => {
      console.error(`Failed to persist cloud saves at ${CLOUD_SAVE_STORE_PATH}:`, error);
    });
  await cloudSaveStoreWritePromise;
}

function sanitizeLoadedCloudSave(rawSave) {
  if (!rawSave || typeof rawSave !== 'object') {
    return null;
  }
  const userId = typeof rawSave.userId === 'string' ? rawSave.userId.trim() : '';
  const identity = normalizeCloudSaveIdentity(rawSave.romHash, rawSave.slotId);
  const dataBase64 = typeof rawSave.dataBase64 === 'string' ? rawSave.dataBase64.trim() : '';
  const updatedAt = typeof rawSave.updatedAt === 'number' ? Math.round(rawSave.updatedAt) : now();
  if (!userId || !identity || !dataBase64) {
    return null;
  }
  const byteLength = typeof rawSave.byteLength === 'number' ? Math.max(0, Math.round(rawSave.byteLength)) : 0;
  return {
    key: cloudSaveKey(userId, identity.romHash, identity.slotId),
    userId,
    romHash: identity.romHash,
    slotId: identity.slotId,
    gameKey: typeof rawSave.gameKey === 'string' ? rawSave.gameKey.slice(0, 200) : undefined,
    gameTitle: typeof rawSave.gameTitle === 'string' ? rawSave.gameTitle.slice(0, 200) : undefined,
    slotName: typeof rawSave.slotName === 'string' ? rawSave.slotName.slice(0, 100) : undefined,
    updatedAt,
    byteLength,
    dataBase64,
  };
}

async function loadCloudSavesFromDisk() {
  try {
    const raw = await readFile(CLOUD_SAVE_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const saves = Array.isArray(parsed?.saves) ? parsed.saves : [];
    for (const rawSave of saves) {
      const sanitized = sanitizeLoadedCloudSave(rawSave);
      if (!sanitized) {
        continue;
      }
      cloudSavesByKey.set(sanitized.key, sanitized);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    console.error('Unable to load cloud saves:', error);
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

  if (
    clean.startsWith('http://')
    || clean.startsWith('https://')
    || clean.startsWith('data:image/')
    || clean.startsWith('/api/avatars/')
  ) {
    return clean;
  }

  return undefined;
}

function sanitizePassword(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseCloudSavePathIdentity(pathname) {
  const match = pathname.match(/^\/api\/cloud-saves\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    const romHash = decodeURIComponent(match[1]);
    const slotId = decodeURIComponent(match[2]);
    return normalizeCloudSaveIdentity(romHash, slotId);
  } catch {
    return null;
  }
}

function createAuthSession(userId) {
  const createdAt = now();
  const session = {
    sessionId: randomUUID(),
    userId,
    createdAt,
    expiresAt: createdAt + normalizeSessionTtlMs(),
    lastSeenAt: createdAt,
  };
  authSessions.set(session.sessionId, session);
  return session;
}

function refreshAuthSession(session) {
  const refreshed = {
    ...session,
    lastSeenAt: now(),
    expiresAt: now() + normalizeSessionTtlMs(),
  };
  authSessions.set(refreshed.sessionId, refreshed);
  return refreshed;
}

function normalizeCloudSaveInput(rawSave) {
  if (!rawSave || typeof rawSave !== 'object') {
    return null;
  }
  const identity = normalizeCloudSaveIdentity(rawSave.romHash, rawSave.slotId);
  const updatedAt = typeof rawSave.updatedAt === 'number' && Number.isFinite(rawSave.updatedAt)
    ? Math.round(rawSave.updatedAt)
    : now();
  const dataBase64 = typeof rawSave.dataBase64 === 'string' ? rawSave.dataBase64.trim() : '';
  if (!identity || !dataBase64) {
    return null;
  }
  let byteLength = 0;
  try {
    byteLength = Buffer.from(dataBase64, 'base64').byteLength;
  } catch {
    return null;
  }
  return {
    romHash: identity.romHash,
    slotId: identity.slotId,
    gameKey: typeof rawSave.gameKey === 'string' ? rawSave.gameKey.trim().slice(0, 200) || undefined : undefined,
    gameTitle: typeof rawSave.gameTitle === 'string' ? rawSave.gameTitle.trim().slice(0, 200) || undefined : undefined,
    slotName: typeof rawSave.slotName === 'string' ? rawSave.slotName.trim().slice(0, 100) || undefined : undefined,
    updatedAt,
    dataBase64,
    byteLength,
  };
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
    withCors(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(req, res, 200, { ok: true, service: 'multiplayer-coordinator' });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/avatars/')) {
    const avatarId = parseAvatarIdFromPath(pathname);
    if (!avatarId) {
      sendJson(req, res, 404, { error: 'Avatar not found.' });
      return;
    }

    const avatarPath = join(AUTH_AVATAR_DIR, basename(avatarId));
    try {
      const bytes = await readFile(avatarPath);
      withCors(req, res);
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', avatarMimeTypeFromFileName(avatarId));
      res.end(bytes);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Avatar not found.' });
        return;
      }
      console.error(`Unable to load avatar ${avatarId}:`, error);
      sendJson(req, res, 500, { error: 'Unable to load avatar.' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    try {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const username = normalizeUsername(body.username);
      const usernameLower = username.toLowerCase();
      const password = sanitizePassword(body.password);

      if (authRateLimitExceeded(req, 'signup', usernameLower)) {
        sendJson(req, res, 429, { error: 'Too many signup attempts. Please wait and try again.' });
        return;
      }

      if (!isValidEmail(email)) {
        sendJson(req, res, 400, { error: 'Email is invalid.' });
        return;
      }
      if (!isValidUsername(username)) {
        sendJson(req, res, 400, { error: 'Username must be 3-32 characters (letters, numbers, _ or -).' });
        return;
      }
      if (password.length < AUTH_PASSWORD_MIN_LENGTH) {
        sendJson(req, res, 400, { error: `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters.` });
        return;
      }

      const emailLower = email.toLowerCase();
      if (authUserIdByUsernameLower.has(usernameLower)) {
        sendJson(req, res, 409, { error: 'Username is already in use.' });
        return;
      }
      if (authUserIdByEmailLower.has(emailLower)) {
        sendJson(req, res, 409, { error: 'Email is already in use.' });
        return;
      }

      const userId = randomUUID();
      const createdAt = now();
      const passwordSaltHex = randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, passwordSaltHex);
      /** @type {AuthUserRecord} */
      const user = {
        userId,
        username,
        usernameLower,
        email,
        emailLower,
        country: detectCountry(req),
        avatarId: undefined,
        passwordSaltHex,
        passwordHashHex: passwordHash.passwordHashHex,
        passwordN: passwordHash.passwordN,
        passwordR: passwordHash.passwordR,
        passwordP: passwordHash.passwordP,
        createdAt,
        updatedAt: createdAt,
      };
      authUsersById.set(userId, user);
      authUserIdByUsernameLower.set(usernameLower, userId);
      authUserIdByEmailLower.set(emailLower, userId);

      const session = createAuthSession(userId);
      setAuthCookie(req, res, session.sessionId, session.expiresAt);

      await Promise.all([
        queueAuthUserPersist(),
        queueAuthSessionPersist(),
      ]);
      sendJson(req, res, 201, { user: userForClient(user) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid signup payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    try {
      const body = await readJsonBody(req);
      const username = normalizeUsername(body.username);
      const usernameLower = username.toLowerCase();
      const password = sanitizePassword(body.password);

      if (authRateLimitExceeded(req, 'login', usernameLower)) {
        sendJson(req, res, 429, { error: 'Too many login attempts. Please wait and try again.' });
        return;
      }

      const userId = authUserIdByUsernameLower.get(usernameLower);
      const user = userId ? authUsersById.get(userId) : undefined;
      if (!user || !verifyPassword(password, user)) {
        sendJson(req, res, 401, { error: 'Username or password is incorrect.' });
        return;
      }

      const session = createAuthSession(user.userId);
      setAuthCookie(req, res, session.sessionId, session.expiresAt);
      await queueAuthSessionPersist();
      sendJson(req, res, 200, { user: userForClient(user) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid login payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const authContext = getAuthenticatedUser(req);
    if (authContext) {
      authSessions.delete(authContext.session.sessionId);
      await queueAuthSessionPersist();
    }
    clearAuthCookie(req, res);
    sendJson(req, res, 200, { loggedOut: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 200, { authenticated: false });
      return;
    }
    const refreshed = refreshAuthSession(authContext.session);
    setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
    await queueAuthSessionPersist();
    sendJson(req, res, 200, {
      authenticated: true,
      user: userForClient(authContext.user),
    });
    return;
  }

  if (req.method === 'PATCH' && pathname === '/api/auth/me') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const nextCountry = normalizeCountry(String(body.country ?? ''));
      if (nextCountry === 'Unknown') {
        sendJson(req, res, 400, { error: 'Country must be a 2-letter country code.' });
        return;
      }
      authContext.user.country = nextCountry;
      authContext.user.updatedAt = now();
      authUsersById.set(authContext.user.userId, authContext.user);
      const refreshed = refreshAuthSession(authContext.session);
      setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
      await Promise.all([
        queueAuthUserPersist(),
        queueAuthSessionPersist(),
      ]);
      sendJson(req, res, 200, { user: userForClient(authContext.user) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid profile update payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/auth/me/avatar') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl.trim() : '';
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        sendJson(req, res, 400, { error: 'Avatar must be a base64 data URL.' });
        return;
      }

      const mimeType = match[1].trim().toLowerCase();
      const dataBase64 = match[2].trim();
      if (!ALLOWED_AVATAR_MIME_TYPES.has(mimeType)) {
        sendJson(req, res, 400, { error: 'Avatar type is unsupported. Use PNG, JPEG, WEBP, or GIF.' });
        return;
      }
      const bytes = Buffer.from(dataBase64, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
        sendJson(req, res, 400, { error: `Avatar must be between 1 byte and ${MAX_AVATAR_BYTES} bytes.` });
        return;
      }

      const extension = AVATAR_MIME_EXTENSION[mimeType];
      const avatarId = `${randomUUID()}${extension}`;
      await mkdir(AUTH_AVATAR_DIR, { recursive: true });
      await writeFile(join(AUTH_AVATAR_DIR, avatarId), bytes);
      await removeAvatarFile(authContext.user.avatarId);
      authContext.user.avatarId = avatarId;
      authContext.user.updatedAt = now();
      authUsersById.set(authContext.user.userId, authContext.user);
      const refreshed = refreshAuthSession(authContext.session);
      setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
      await Promise.all([
        queueAuthUserPersist(),
        queueAuthSessionPersist(),
      ]);
      sendJson(req, res, 200, {
        avatarUrl: `/api/avatars/${encodeURIComponent(avatarId)}`,
        user: userForClient(authContext.user),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid avatar payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/auth/me/avatar') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }

    await removeAvatarFile(authContext.user.avatarId);
    authContext.user.avatarId = undefined;
    authContext.user.updatedAt = now();
    authUsersById.set(authContext.user.userId, authContext.user);
    const refreshed = refreshAuthSession(authContext.session);
    setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
    await Promise.all([
      queueAuthUserPersist(),
      queueAuthSessionPersist(),
    ]);
    sendJson(req, res, 200, { deleted: true, user: userForClient(authContext.user) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/cloud-saves') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    const saves = [...cloudSavesByKey.values()]
      .filter((save) => save.userId === authContext.user.userId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((save) => cloudSaveForClient(save, false));
    const refreshed = refreshAuthSession(authContext.session);
    setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
    await queueAuthSessionPersist();
    sendJson(req, res, 200, { saves });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/cloud-saves/')) {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    const identity = parseCloudSavePathIdentity(pathname);
    if (!identity) {
      sendJson(req, res, 400, { error: 'Invalid cloud save key.' });
      return;
    }
    const save = cloudSavesByKey.get(cloudSaveKey(authContext.user.userId, identity.romHash, identity.slotId));
    if (!save) {
      sendJson(req, res, 404, { error: 'Cloud save not found.' });
      return;
    }
    const refreshed = refreshAuthSession(authContext.session);
    setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
    await queueAuthSessionPersist();
    sendJson(req, res, 200, { save: cloudSaveForClient(save, true) });
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/cloud-saves') {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const rawSaves = Array.isArray(body?.saves)
        ? body.saves
        : body?.save
          ? [body.save]
          : [];

      let changed = false;
      for (const rawSave of rawSaves) {
        const normalized = normalizeCloudSaveInput(rawSave);
        if (!normalized) {
          continue;
        }
        const key = cloudSaveKey(authContext.user.userId, normalized.romHash, normalized.slotId);
        const existing = cloudSavesByKey.get(key);
        if (existing && normalized.updatedAt < existing.updatedAt) {
          continue;
        }
        /** @type {CloudSaveRecord} */
        const nextRecord = {
          key,
          userId: authContext.user.userId,
          romHash: normalized.romHash,
          slotId: normalized.slotId,
          gameKey: normalized.gameKey,
          gameTitle: normalized.gameTitle,
          slotName: normalized.slotName,
          updatedAt: normalized.updatedAt,
          byteLength: normalized.byteLength,
          dataBase64: normalized.dataBase64,
        };
        cloudSavesByKey.set(key, nextRecord);
        changed = true;
      }

      if (changed) {
        await queueCloudSavePersist();
      }
      const refreshed = refreshAuthSession(authContext.session);
      setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
      await queueAuthSessionPersist();
      const saves = [...cloudSavesByKey.values()]
        .filter((save) => save.userId === authContext.user.userId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((save) => cloudSaveForClient(save, false));
      sendJson(req, res, 200, { saves });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid cloud save payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/cloud-saves/')) {
    const authContext = getAuthenticatedUser(req);
    if (!authContext) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    const identity = parseCloudSavePathIdentity(pathname);
    if (!identity) {
      sendJson(req, res, 400, { error: 'Invalid cloud save key.' });
      return;
    }
    const key = cloudSaveKey(authContext.user.userId, identity.romHash, identity.slotId);
    const deleted = cloudSavesByKey.delete(key);
    if (deleted) {
      await queueCloudSavePersist();
    }
    const refreshed = refreshAuthSession(authContext.session);
    setAuthCookie(req, res, refreshed.sessionId, refreshed.expiresAt);
    await queueAuthSessionPersist();
    sendJson(req, res, 200, { deleted });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/controller-profiles') {
    sendJson(req, res, 200, { profiles: listSharedProfiles() });
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

      sendJson(req, res, 200, { profiles: listSharedProfiles(), updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid profile payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/controller-profiles/')) {
    const profileId = parseControllerProfileId(pathname);
    if (!profileId) {
      sendJson(req, res, 400, { error: 'Invalid profile id.' });
      return;
    }

    const deleted = sharedControllerProfiles.delete(profileId);
    if (deleted) {
      await queueProfilePersist();
    }

    sendJson(req, res, 200, { deleted });
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

      sendJson(req, res, 201, {
        code,
        clientId: hostClientId,
        session: publicSession(session),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid session create payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/join')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(req, res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(req, res, 404, { error: 'Invite code was not found.' });
      return;
    }

    if (session.joinLocked) {
      sendJson(req, res, 423, { error: 'This room is locked by the host. Ask the host to unlock joins.' });
      return;
    }

    const openSlot = findOpenPlayerSlot(session);
    if (!openSlot) {
      sendJson(req, res, 409, { error: 'Session is full (maximum 4 players).' });
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

      sendJson(req, res, 200, {
        code,
        clientId,
        session: publicSession(session),
      });
      broadcastRoomState(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid join payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/close')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(req, res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(req, res, 404, { error: 'Invite code was not found.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      if (clientId !== session.hostClientId) {
        sendJson(req, res, 403, { error: 'Only the host can close this session.' });
        return;
      }

      closeSession(session, {
        notify: true,
        notifyReason: 'Host ended the session.',
        socketReason: 'Host ended session',
      });
      sendJson(req, res, 200, {
        closed: true,
        code,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid close payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/multiplayer/sessions/') && pathname.endsWith('/kick')) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(req, res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(req, res, 404, { error: 'Invite code was not found.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      const targetClientId = typeof body.targetClientId === 'string' ? body.targetClientId : '';
      if (clientId !== session.hostClientId) {
        sendJson(req, res, 403, { error: 'Only the host can kick players.' });
        return;
      }

      const target = session.members.get(targetClientId);
      if (!target || target.isHost) {
        sendJson(req, res, 404, { error: 'Kick target was not found.' });
        return;
      }

      const host = session.members.get(session.hostClientId);
      removeMember(session, target, {
        byName: host?.name ?? 'Host',
        kickedReason: 'You were removed by the host.',
        closeSocketReason: 'Kicked by host',
      });
      broadcastRoomState(session);

      sendJson(req, res, 200, {
        kicked: true,
        code,
        targetClientId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid kick payload.';
      sendJson(req, res, 400, { error: message });
    }
    return;
  }

  if (req.method === 'GET' && isSessionBasePath(pathname)) {
    const code = parseSessionCodeFromPath(pathname);
    if (!code) {
      sendJson(req, res, 404, { error: 'Session route not found.' });
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      sendJson(req, res, 404, { error: 'Invite code was not found.' });
      return;
    }

    sendJson(req, res, 200, {
      session: publicSession(session),
    });
    return;
  }

  sendJson(req, res, 404, { error: 'Not found.' });
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

await Promise.all([
  loadSharedProfilesFromDisk(),
  loadUsersFromDisk(),
  loadAuthSessionsFromDisk(),
  loadCloudSavesFromDisk(),
]);

for (const [sessionId, session] of authSessions.entries()) {
  if (session.expiresAt <= now()) {
    authSessions.delete(sessionId);
  }
}

await mkdir(AUTH_AVATAR_DIR, { recursive: true });

console.log(`Loaded ${sharedControllerProfiles.size} shared controller profile(s) from ${CONTROLLER_PROFILE_STORE_PATH}.`);
console.log(`Loaded ${authUsersById.size} auth user(s) from ${AUTH_USER_STORE_PATH}.`);
console.log(`Loaded ${authSessions.size} auth session(s) from ${AUTH_SESSION_STORE_PATH}.`);
console.log(`Loaded ${cloudSavesByKey.size} cloud save(s) from ${CLOUD_SAVE_STORE_PATH}.`);

httpServer.listen(PORT, HOST, () => {
  console.log(`Multiplayer coordinator listening at http://${HOST}:${PORT}`);
});
