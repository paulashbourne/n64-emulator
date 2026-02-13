import {
  getAdvancedSaveSlotsEnabled,
  clearRecentOnlineSessions,
  getOnlineIdentityProfile,
  getPreferredBootMode,
  getPreferredFavoritesOnly,
  getPreferredLibrarySortMode,
  removeRecentOnlineSession,
  getRecentOnlineSessions,
  rememberOnlineSession,
  setAdvancedSaveSlotsEnabled,
  setOnlineIdentityProfile,
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

  test('persists advanced save slots toggle', async () => {
    await expect(getAdvancedSaveSlotsEnabled()).resolves.toBe(false);
    await setAdvancedSaveSlotsEnabled(true);
    await expect(getAdvancedSaveSlotsEnabled()).resolves.toBe(true);
  });

  test('remembers recent online sessions with newest first', async () => {
    await rememberOnlineSession({
      code: 'ABC123',
      clientId: 'host-client',
      playerName: 'Host',
      role: 'host',
      romTitle: 'Mario Kart 64',
    });

    await rememberOnlineSession({
      code: 'DEF456',
      clientId: 'guest-client',
      playerName: 'Guest',
      role: 'guest',
    });

    const recent = await getRecentOnlineSessions();
    expect(recent).toHaveLength(2);
    expect(recent[0].code).toBe('DEF456');
    expect(recent[1].code).toBe('ABC123');
  });

  test('dedupes existing recent session and clears history', async () => {
    await rememberOnlineSession({
      code: 'ABC123',
      clientId: 'client-1',
      playerName: 'One',
      role: 'guest',
    });
    await rememberOnlineSession({
      code: 'ABC123',
      clientId: 'client-1',
      playerName: 'One Updated',
      role: 'guest',
    });

    let recent = await getRecentOnlineSessions();
    expect(recent).toHaveLength(1);
    expect(recent[0].playerName).toBe('One Updated');

    await clearRecentOnlineSessions();
    recent = await getRecentOnlineSessions();
    expect(recent).toHaveLength(0);
  });

  test('removes one recent online session entry by code and client id', async () => {
    await rememberOnlineSession({
      code: 'ABC123',
      clientId: 'host-1',
      playerName: 'Host',
      role: 'host',
    });
    await rememberOnlineSession({
      code: 'ABC123',
      clientId: 'guest-2',
      playerName: 'Guest',
      role: 'guest',
    });

    await removeRecentOnlineSession('abc123', 'guest-2');
    const recent = await getRecentOnlineSessions();
    expect(recent).toHaveLength(1);
    expect(recent[0].clientId).toBe('host-1');
  });

  test('persists online identity profile', async () => {
    await setOnlineIdentityProfile({
      playerName: 'Paul',
      avatarUrl: 'https://example.com/paul.png',
    });

    await expect(getOnlineIdentityProfile()).resolves.toEqual({
      playerName: 'Paul',
      avatarUrl: 'https://example.com/paul.png',
    });
  });
});
