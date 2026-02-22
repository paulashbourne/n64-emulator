import { beforeEach, describe, expect, test, vi } from 'vitest';

import { db } from '../storage/db';
import {
  getLocalSaveSlotBlob,
  persistRuntimeSaveForSlot,
  reconcileSlotSaveWithCloud,
} from './cloudSaveSync';

vi.mock('../online/authApi', () => ({
  deleteCloudSave: vi.fn(async () => true),
  getCloudSave: vi.fn(async () => null),
  upsertCloudSaves: vi.fn(async () => []),
}));

describe('cloudSaveSync', () => {
  beforeEach(async () => {
    await db.saveSlots.clear();
    await db.saveSlotBlobs.clear();
    vi.clearAllMocks();
  });

  test('persists local save slot blob when guest user saves', async () => {
    const slot = {
      slotId: 'slot:test-1',
      gameKey: 'game:test',
      gameTitle: 'Test Game',
      romHash: 'rom-hash-a',
      slotName: 'Main Save',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.saveSlots.put(slot);

    await persistRuntimeSaveForSlot({
      slot,
      bytes: new Uint8Array([1, 2, 3, 4]),
      authenticated: false,
    });

    const blob = await getLocalSaveSlotBlob(slot.slotId);
    expect(blob).toBeDefined();
    expect(blob?.romHash).toBe(slot.romHash);
    expect(new Uint8Array(blob?.data ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test('reuses local save data when guest user boots slot', async () => {
    const slot = {
      slotId: 'slot:test-2',
      gameKey: 'game:test',
      gameTitle: 'Test Game',
      romHash: 'rom-hash-b',
      slotName: 'Main Save',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.saveSlots.put(slot);

    await persistRuntimeSaveForSlot({
      slot,
      bytes: new Uint8Array([9, 8, 7]),
      authenticated: false,
    });

    const reconciled = await reconcileSlotSaveWithCloud({
      slot,
      authenticated: false,
    });
    expect(reconciled.bytesToApply).toBeDefined();
    expect(reconciled.bytesToApply).toEqual(new Uint8Array([9, 8, 7]));
  });
});
