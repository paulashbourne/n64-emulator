import {
  getPreferredBootMode,
  getPreferredFavoritesOnly,
  getPreferredLibrarySortMode,
  setPreferredBootMode,
  setPreferredFavoritesOnly,
  setPreferredLibrarySortMode,
} from './appSettings';
import { db } from './db';

describe('app settings', () => {
  beforeEach(async () => {
    await db.settings.clear();
  });

  test('returns auto boot mode when no setting exists', async () => {
    await expect(getPreferredBootMode()).resolves.toBe('auto');
  });

  test('persists preferred boot mode', async () => {
    await setPreferredBootMode('cdn');
    await expect(getPreferredBootMode()).resolves.toBe('cdn');
  });

  test('persists preferred library sort mode', async () => {
    await setPreferredLibrarySortMode('favorite');
    await expect(getPreferredLibrarySortMode()).resolves.toBe('favorite');
  });

  test('persists favorites-only library filter', async () => {
    await setPreferredFavoritesOnly(true);
    await expect(getPreferredFavoritesOnly()).resolves.toBe(true);
  });
});
