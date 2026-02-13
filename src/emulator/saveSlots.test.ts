import { beforeEach, describe, expect, test } from 'vitest';

import {
  buildEmulatorGameId,
  chooseBootSaveSlot,
  createSaveSlot,
  deleteSaveSlotsForGame,
  listSaveSlotsForGame,
  listSaveSummariesByGame,
  markSaveSlotPlayed,
  markSaveSlotSaved,
  resolveSaveGameIdentity,
} from './saveSlots';
import { db } from '../storage/db';

describe('save slots', () => {
  beforeEach(async () => {
    await db.saveSlots.clear();
  });

  test('resolves shared game identity for known cover aliases', () => {
    const left = resolveSaveGameIdentity({
      title: 'SUPER MARIO 64',
    });
    const right = resolveSaveGameIdentity({
      title: 'Super Mario 64 (USA)',
      relativePath: 'Roms/Super Mario 64 (USA).z64',
    });

    expect(left.gameKey).toBe(right.gameKey);
    expect(left.displayTitle).toBe('Super Mario 64');
    expect(right.displayTitle).toBe('Super Mario 64');
  });

  test('creates default boot slot when no slot exists', async () => {
    const identity = resolveSaveGameIdentity({
      title: 'Mystery Game',
    });

    const result = await chooseBootSaveSlot(identity);
    expect(result.slots).toHaveLength(1);
    expect(result.activeSlot.slotName).toBe('Main Save');
  });

  test('tracks save and played timestamps per slot', async () => {
    const identity = resolveSaveGameIdentity({
      title: 'Diddy Kong Racing',
    });
    const slot = await createSaveSlot(identity, { slotName: 'Profile A' });

    await markSaveSlotPlayed(slot.slotId);
    await markSaveSlotSaved(slot.slotId);

    const [saved] = await listSaveSlotsForGame(identity.gameKey);
    expect(saved.slotName).toBe('Profile A');
    expect(typeof saved.lastPlayedAt).toBe('number');
    expect(typeof saved.lastSavedAt).toBe('number');
  });

  test('builds stable emulator game ids by game key + slot', () => {
    const gameId = buildEmulatorGameId('game:super-mario-64', 'slot:main-save');
    expect(gameId).toBe('warpdeck64:super-mario-64:slot:main-save');
  });

  test('summaries reflect primary slot and slot counts', async () => {
    const identity = resolveSaveGameIdentity({
      title: 'Banjo-Kazooie',
    });

    const slotA = await createSaveSlot(identity, { slotName: 'Main Save' });
    await markSaveSlotSaved(slotA.slotId);
    const slotB = await createSaveSlot(identity, { slotName: 'Challenge Run' });
    await markSaveSlotPlayed(slotB.slotId);

    const summaries = await listSaveSummariesByGame([identity.gameKey]);
    const summary = summaries.get(identity.gameKey);
    expect(summary).toBeDefined();
    expect(summary?.slotCount).toBe(2);
    expect(summary?.primarySlotId).toBe(slotB.slotId);
    expect(summary?.primarySlotName).toBe('Challenge Run');
  });

  test('deletes all slots for a game', async () => {
    const identity = resolveSaveGameIdentity({
      title: 'GoldenEye',
    });
    await createSaveSlot(identity, { slotName: 'Main Save' });
    await createSaveSlot(identity, { slotName: 'Second Slot' });

    const removed = await deleteSaveSlotsForGame(identity.gameKey);
    expect(removed).toBe(2);

    const remaining = await listSaveSlotsForGame(identity.gameKey);
    expect(remaining).toHaveLength(0);
  });
});
