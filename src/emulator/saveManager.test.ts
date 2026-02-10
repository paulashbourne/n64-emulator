import { db } from '../storage/db';
import { SaveManager, saveKeyForRom } from './saveManager';

function textBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

async function readBuffer(data: ArrayBuffer): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(data));
}

describe('save manager', () => {
  const manager = new SaveManager();

  beforeEach(async () => {
    await db.saves.clear();
  });

  test('keys saves by ROM hash', async () => {
    await manager.persistForRom('hash-a', textBytes('save-a'));
    await manager.persistForRom('hash-b', textBytes('save-b'));

    const saveA = await manager.loadForRom('hash-a');
    const saveB = await manager.loadForRom('hash-b');

    expect(saveA).toBeDefined();
    expect(saveB).toBeDefined();
    expect(await readBuffer(saveA!)).toBe('save-a');
    expect(await readBuffer(saveB!)).toBe('save-b');

    const allSaves = await db.saves.toArray();
    expect(allSaves).toHaveLength(2);
    expect(allSaves.some((entry) => entry.key === saveKeyForRom('hash-a'))).toBe(true);
    expect(allSaves.some((entry) => entry.key === saveKeyForRom('hash-b'))).toBe(true);
  });
});
