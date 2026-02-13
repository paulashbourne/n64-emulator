import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import { db } from './db';

const BOOT_MODE_KEY = 'boot_mode';
const LIBRARY_SORT_MODE_KEY = 'library_sort_mode';
const LIBRARY_FAVORITES_ONLY_KEY = 'library_favorites_only';
const ADVANCED_SAVE_SLOTS_ENABLED_KEY = 'advanced_save_slots_enabled_v1';
const RECENT_ONLINE_SESSIONS_KEY = 'recent_online_sessions_v1';
const ONLINE_IDENTITY_PROFILE_KEY = 'online_identity_profile_v1';
const MAX_RECENT_ONLINE_SESSIONS = 8;

type LibrarySortMode = 'title' | 'lastPlayed' | 'size' | 'favorite';
export type OnlineSessionRole = 'host' | 'guest';

export interface RecentOnlineSession {
  code: string;
  clientId: string;
  playerName: string;
  avatarUrl?: string;
  role: OnlineSessionRole;
  romId?: string;
  romTitle?: string;
  lastActiveAt: number;
}

export interface OnlineIdentityProfile {
  playerName: string;
  avatarUrl?: string;
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

export async function getAdvancedSaveSlotsEnabled(): Promise<boolean> {
  const setting = await db.settings.get(ADVANCED_SAVE_SLOTS_ENABLED_KEY);
  if (!setting) {
    return false;
  }
  return setting.value === 'true';
}

export async function setAdvancedSaveSlotsEnabled(enabled: boolean): Promise<void> {
  await db.settings.put({
    key: ADVANCED_SAVE_SLOTS_ENABLED_KEY,
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
    avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl.trim().slice(0, 500) || undefined : undefined,
    role: parsed.role,
    romId: typeof parsed.romId === 'string' ? parsed.romId.trim() || undefined : undefined,
    romTitle: typeof parsed.romTitle === 'string' ? parsed.romTitle.trim().slice(0, 100) : undefined,
    lastActiveAt: parsed.lastActiveAt,
  };
}

export async function getRecentOnlineSessions(): Promise<RecentOnlineSession[]> {
  try {
    const setting = await db.settings.get(RECENT_ONLINE_SESSIONS_KEY);
    if (!setting) {
      return [];
    }

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
  avatarUrl?: string;
  role: OnlineSessionRole;
  romId?: string;
  romTitle?: string;
}): Promise<void> {
  const normalized: RecentOnlineSession = {
    code: input.code.trim().toUpperCase(),
    clientId: input.clientId.trim(),
    playerName: input.playerName.trim().slice(0, 32) || 'Player',
    avatarUrl: input.avatarUrl?.trim().slice(0, 500) || undefined,
    role: input.role,
    romId: input.romId?.trim() || undefined,
    romTitle: input.romTitle?.trim().slice(0, 100) || undefined,
    lastActiveAt: Date.now(),
  };

  const existing = await getRecentOnlineSessions();
  const deduped = existing.filter(
    (entry) => !(entry.code === normalized.code && entry.clientId === normalized.clientId),
  );
  const next = [normalized, ...deduped].slice(0, MAX_RECENT_ONLINE_SESSIONS);

  try {
    await db.settings.put({
      key: RECENT_ONLINE_SESSIONS_KEY,
      value: JSON.stringify(next),
      updatedAt: Date.now(),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('Could not store recent online session.');
  }
}

export async function clearRecentOnlineSessions(): Promise<void> {
  try {
    await db.settings.delete(RECENT_ONLINE_SESSIONS_KEY);
  } catch (error) {
    throw error instanceof Error ? error : new Error('Could not clear recent online sessions.');
  }
}

export async function removeRecentOnlineSession(code: string, clientId: string): Promise<void> {
  const normalizedCode = code.trim().toUpperCase();
  const normalizedClientId = clientId.trim();
  const existing = await getRecentOnlineSessions();
  const next = existing.filter(
    (entry) => !(entry.code === normalizedCode && entry.clientId === normalizedClientId),
  );

  try {
    if (next.length === 0) {
      await db.settings.delete(RECENT_ONLINE_SESSIONS_KEY);
      return;
    }
    await db.settings.put({
      key: RECENT_ONLINE_SESSIONS_KEY,
      value: JSON.stringify(next),
      updatedAt: Date.now(),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('Could not remove recent online session.');
  }
}

function normalizeProfileName(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Player';
  }
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 32);
  return normalized.length > 0 ? normalized : 'Player';
}

function normalizeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().slice(0, 500);
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('data:image/')) {
    return normalized;
  }
  return undefined;
}

export async function getOnlineIdentityProfile(): Promise<OnlineIdentityProfile> {
  const setting = await db.settings.get(ONLINE_IDENTITY_PROFILE_KEY);
  if (!setting) {
    return {
      playerName: 'Player',
    };
  }

  try {
    const parsed = JSON.parse(setting.value) as Partial<OnlineIdentityProfile>;
    return {
      playerName: normalizeProfileName(parsed.playerName),
      avatarUrl: normalizeAvatarUrl(parsed.avatarUrl),
    };
  } catch {
    return {
      playerName: 'Player',
    };
  }
}

export async function setOnlineIdentityProfile(profile: OnlineIdentityProfile): Promise<void> {
  const normalized: OnlineIdentityProfile = {
    playerName: normalizeProfileName(profile.playerName),
    avatarUrl: normalizeAvatarUrl(profile.avatarUrl),
  };

  try {
    await db.settings.put({
      key: ONLINE_IDENTITY_PROFILE_KEY,
      value: JSON.stringify(normalized),
      updatedAt: Date.now(),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('Could not save online identity profile.');
  }
}
