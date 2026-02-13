import Dexie, { type Table } from 'dexie';

import type { ControllerProfile } from '../types/input';
import type {
  DirectoryRecord,
  RomBinaryRecord,
  RomHandleRecord,
  RomRecord,
} from '../types/rom';
import type { SaveSlotRecord } from '../types/save';

export interface SaveRecord {
  key: string;
  romHash: string;
  data: ArrayBuffer;
  updatedAt: number;
}

export interface AppSettingRecord {
  key: string;
  value: string;
  updatedAt: number;
}

class AppDatabase extends Dexie {
  roms!: Table<RomRecord, string>;
  romHandles!: Table<RomHandleRecord, string>;
  romBinaries!: Table<RomBinaryRecord, string>;
  directories!: Table<DirectoryRecord, string>;
  profiles!: Table<ControllerProfile, string>;
  saves!: Table<SaveRecord, string>;
  saveSlots!: Table<SaveSlotRecord, string>;
  settings!: Table<AppSettingRecord, string>;

  constructor() {
    super('n64_emulator_db');

    this.version(1).stores({
      roms: '&id,hash,title,lastPlayed,directoryId,source',
      romHandles: '&id,romId,directoryId,relativePath',
      romBinaries: '&romId,updatedAt',
      directories: '&id,name,lastIndexedAt',
      profiles: '&profileId,deviceId,romHash,updatedAt',
      saves: '&key,romHash,updatedAt',
      settings: '&key,updatedAt',
    });

    this.version(2)
      .stores({
        roms: '&id,hash,title,lastPlayed,directoryId,source,favorite',
        romHandles: '&id,romId,directoryId,relativePath',
        romBinaries: '&romId,updatedAt',
        directories: '&id,name,lastIndexedAt',
        profiles: '&profileId,deviceId,romHash,updatedAt',
        saves: '&key,romHash,updatedAt',
        settings: '&key,updatedAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('roms')
          .toCollection()
          .modify((rom: { favorite?: boolean }) => {
            if (typeof rom.favorite !== 'boolean') {
              rom.favorite = false;
            }
          });
      });

    this.version(3).stores({
      roms: '&id,hash,title,lastPlayed,directoryId,source,favorite',
      romHandles: '&id,romId,directoryId,relativePath',
      romBinaries: '&romId,updatedAt',
      directories: '&id,name,lastIndexedAt',
      profiles: '&profileId,deviceId,romHash,updatedAt',
      saves: '&key,romHash,updatedAt',
      saveSlots: '&slotId,gameKey,updatedAt,lastSavedAt,lastPlayedAt',
      settings: '&key,updatedAt',
    });
  }
}

export const db = new AppDatabase();

export async function clearIndexedData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.roms, db.romHandles, db.romBinaries, db.directories, db.profiles, db.saves, db.saveSlots, db.settings],
    async () => {
      await db.roms.clear();
      await db.romHandles.clear();
      await db.romBinaries.clear();
      await db.directories.clear();
      await db.profiles.clear();
      await db.saves.clear();
      await db.saveSlots.clear();
      await db.settings.clear();
    },
  );
}
