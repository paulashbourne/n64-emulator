import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import { db } from './db';

const BOOT_MODE_KEY = 'boot_mode';
const LIBRARY_SORT_MODE_KEY = 'library_sort_mode';
const LIBRARY_FAVORITES_ONLY_KEY = 'library_favorites_only';

type LibrarySortMode = 'title' | 'lastPlayed' | 'size' | 'favorite';

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
