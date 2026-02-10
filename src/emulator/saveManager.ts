import { db } from '../storage/db';

function cloneArrayBuffer(data: ArrayBuffer): ArrayBuffer {
  return data.slice(0);
}

export function saveKeyForRom(romHash: string): string {
  return `save:${romHash}`;
}

export class SaveManager {
  async loadForRom(romHash: string): Promise<ArrayBuffer | undefined> {
    const record = await db.saves.get(saveKeyForRom(romHash));
    return record ? cloneArrayBuffer(record.data) : undefined;
  }

  async persistForRom(romHash: string, data: ArrayBuffer): Promise<void> {
    await db.saves.put({
      key: saveKeyForRom(romHash),
      romHash,
      data: cloneArrayBuffer(data),
      updatedAt: Date.now(),
    });
  }

  async deleteForRom(romHash: string): Promise<void> {
    await db.saves.delete(saveKeyForRom(romHash));
  }
}

export const saveManager = new SaveManager();
