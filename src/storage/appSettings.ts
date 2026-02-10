import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import { db } from './db';

const BOOT_MODE_KEY = 'boot_mode';
const LIBRARY_SORT_MODE_KEY = 'library_sort_mode';
const LIBRARY_FAVORITES_ONLY_KEY = 'library_favorites_only';
const RECENT_ONLINE_SESSIONS_KEY = 'recent_online_sessions_v1';
const MAX_RECENT_ONLINE_SESSIONS = 8;

type LibrarySortMode = 'title' | 'lastPlayed' | 'size' | 'favorite';
export type OnlineSessionRole = 'host' | 'guest';

export interface RecentOnlineSession {
  code: string;
  clientId: string;
  playerName: string;
  role: OnlineSessionRole;
  romTitle?: string;
  lastActiveAt: number;
}

function isBootMode(value: string): value is EmulatorBootMode {
  return value === 'auto' || value === 'local' || value === 'cdn';
}

function isLibrarySortMode(value: string): value is LibrarySortMode {
  return value === 'title' || value === 'lastPlayed' || value === 'size' || value === 'favorite';
}

export async function getPreferredBootMode(): Promise<EmulatorBootMode> {
  const setting = await db.settings.get(BOOT_MODE_KEY);
  if (!setting) {
    return 'auto';
  }

  return isBootMode(setting.value) ? setting.value : 'auto';
}

export async function setPreferredBootMode(mode: EmulatorBootMode): Promise<void> {
  await db.settings.put({
    key: BOOT_MODE_KEY,
    value: mode,
    updatedAt: Date.now(),
  });
}

export async function getPreferredLibrarySortMode(): Promise<LibrarySortMode> {
  const setting = await db.settings.get(LIBRARY_SORT_MODE_KEY);
  if (!setting) {
    return 'title';
  }

  return isLibrarySortMode(setting.value) ? setting.value : 'title';
}

export async function setPreferredLibrarySortMode(mode: LibrarySortMode): Promise<void> {
  await db.settings.put({
    key: LIBRARY_SORT_MODE_KEY,
    value: mode,
    updatedAt: Date.now(),
  });
}

export async function getPreferredFavoritesOnly(): Promise<boolean> {
  const setting = await db.settings.get(LIBRARY_FAVORITES_ONLY_KEY);
  if (!setting) {
    return false;
  }
  return setting.value === 'true';
}

export async function setPreferredFavoritesOnly(enabled: boolean): Promise<void> {
  await db.settings.put({
    key: LIBRARY_FAVORITES_ONLY_KEY,
    value: enabled ? 'true' : 'false',
    updatedAt: Date.now(),
  });
}

function normalizeRecentOnlineSession(input: unknown): RecentOnlineSession | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const parsed = input as Partial<RecentOnlineSession>;
  if (
    typeof parsed.code !== 'string' ||
    typeof parsed.clientId !== 'string' ||
    typeof parsed.playerName !== 'string' ||
    (parsed.role !== 'host' && parsed.role !== 'guest') ||
    typeof parsed.lastActiveAt !== 'number'
  ) {
    return null;
  }

  return {
    code: parsed.code.trim().toUpperCase(),
    clientId: parsed.clientId.trim(),
    playerName: parsed.playerName.trim().slice(0, 32) || 'Player',
    role: parsed.role,
    romTitle: typeof parsed.romTitle === 'string' ? parsed.romTitle.trim().slice(0, 100) : undefined,
    lastActiveAt: parsed.lastActiveAt,
  };
}

export async function getRecentOnlineSessions(): Promise<RecentOnlineSession[]> {
  const setting = await db.settings.get(RECENT_ONLINE_SESSIONS_KEY);
  if (!setting) {
    return [];
  }

  try {
    const decoded = JSON.parse(setting.value) as unknown[];
    if (!Array.isArray(decoded)) {
      return [];
    }

    return decoded
      .map(normalizeRecentOnlineSession)
      .filter((entry): entry is RecentOnlineSession => entry !== null)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, MAX_RECENT_ONLINE_SESSIONS);
  } catch {
    return [];
  }
}

export async function rememberOnlineSession(input: {
  code: string;
  clientId: string;
  playerName: string;
  role: OnlineSessionRole;
  romTitle?: string;
}): Promise<void> {
  const normalized: RecentOnlineSession = {
    code: input.code.trim().toUpperCase(),
    clientId: input.clientId.trim(),
    playerName: input.playerName.trim().slice(0, 32) || 'Player',
    role: input.role,
    romTitle: input.romTitle?.trim().slice(0, 100) || undefined,
    lastActiveAt: Date.now(),
  };

  const existing = await getRecentOnlineSessions();
  const deduped = existing.filter(
    (entry) => !(entry.code === normalized.code && entry.clientId === normalized.clientId),
  );
  const next = [normalized, ...deduped].slice(0, MAX_RECENT_ONLINE_SESSIONS);

  await db.settings.put({
    key: RECENT_ONLINE_SESSIONS_KEY,
    value: JSON.stringify(next),
    updatedAt: Date.now(),
  });
}

export async function clearRecentOnlineSessions(): Promise<void> {
  await db.settings.delete(RECENT_ONLINE_SESSIONS_KEY);
}
