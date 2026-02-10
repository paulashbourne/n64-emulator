import { db } from '../storage/db';
import type { RomRecord, ScannedRom } from '../types/rom';
import { scanDirectoryRoms, scanImportedFiles } from './scanner';

export type RomSortMode = 'title' | 'lastPlayed' | 'size' | 'favorite';

export interface CatalogQuery {
  search?: string;
  sort?: RomSortMode;
  favoritesOnly?: boolean;
}

interface IndexDirectoryResult {
  directoryId: string;
  roms: RomRecord[];
}

export interface ImportRomFilesResult {
  imported: RomRecord[];
  skipped: number;
  total: number;
}

function isDataCloneError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'DataCloneError';
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return (error as { name?: string }).name === 'DataCloneError';
  }
  return false;
}

function now(): number {
  return Date.now();
}

function makeDirectoryId(name: string): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `dir:${safeName || 'roms'}:${crypto.randomUUID()}`;
}

function directoryRomId(directoryId: string, relativePath: string | undefined, hash: string): string {
  const path = relativePath ? relativePath.toLowerCase() : hash;
  return `${directoryId}:${path}`;
}

function handleIdForRom(romId: string): string {
  return `handle:${romId}`;
}

async function ensurePermission(handle: FileSystemHandle): Promise<boolean> {
  if (
    !('queryPermission' in handle) ||
    typeof handle.queryPermission !== 'function' ||
    !('requestPermission' in handle) ||
    typeof handle.requestPermission !== 'function'
  ) {
    return true;
  }

  const permissionHandle = handle as FileSystemHandle & {
    queryPermission: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };

  const currentPermission = await permissionHandle.queryPermission({ mode: 'read' });
  if (currentPermission === 'granted') {
    return true;
  }

  if (currentPermission === 'prompt') {
    const requestedPermission = await permissionHandle.requestPermission({ mode: 'read' });
    return requestedPermission === 'granted';
  }

  return false;
}

function toRomRecord(scanned: ScannedRom, romId: string, directoryId?: string): RomRecord {
  const timestamp = now();
  const handleRef = scanned.fileHandle
    ? {
        romHandleId: handleIdForRom(romId),
        directoryId,
        relativePath: scanned.relativePath,
      }
    : undefined;

  return {
    id: romId,
    hash: scanned.hash,
    title: scanned.title,
    size: scanned.size,
    extension: scanned.extension,
    source: directoryId ? 'directory' : 'import',
    favorite: false,
    addedAt: timestamp,
    lastPlayed: undefined,
    directoryId,
    relativePath: scanned.relativePath,
    handleRef,
  };
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function indexDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  existingDirectoryId?: string,
): Promise<IndexDirectoryResult> {
  const directoryId = existingDirectoryId ?? makeDirectoryId(directoryHandle.name);
  const scannedRoms = await scanDirectoryRoms(directoryHandle);
  const timestamp = now();

  const baseRomRecords = scannedRoms.map((scanned) => {
    const romId = directoryRomId(directoryId, scanned.relativePath, scanned.hash);
    return toRomRecord(scanned, romId, directoryId);
  });
  const mergedRomRecords: RomRecord[] = [];

  await db.transaction('rw', [db.directories, db.roms, db.romHandles, db.romBinaries], async () => {
    const directoryRecord = {
      id: directoryId,
      name: directoryHandle.name,
      handle: directoryHandle,
      addedAt: timestamp,
      lastIndexedAt: timestamp,
    };

    try {
      await db.directories.put(directoryRecord);
    } catch (error) {
      if (!isDataCloneError(error)) {
        throw error;
      }

      await db.directories.put({
        ...directoryRecord,
        handle: undefined,
      });
    }

    const existingRoms = await db.roms.where('directoryId').equals(directoryId).toArray();
    const existingById = new Map(existingRoms.map((record) => [record.id, record]));
    const currentIds = new Set(baseRomRecords.map((record) => record.id));
    const staleRoms = existingRoms.filter((existing) => !currentIds.has(existing.id));

    if (staleRoms.length > 0) {
      const staleIds = staleRoms.map((record) => record.id);
      await db.roms.bulkDelete(staleIds);
      await db.romHandles.bulkDelete(staleIds.map((romId) => handleIdForRom(romId)));
      await db.romBinaries.bulkDelete(staleIds);
    }

    for (let index = 0; index < baseRomRecords.length; index += 1) {
      const romRecord = baseRomRecords[index];
      const previous = existingById.get(romRecord.id);
      const mergedRecord: RomRecord = {
        ...romRecord,
        addedAt: previous?.addedAt ?? romRecord.addedAt,
        lastPlayed: previous?.lastPlayed,
        favorite: previous?.favorite ?? romRecord.favorite,
      };
      const scanned = scannedRoms[index];
      await db.roms.put(mergedRecord);
      await db.romBinaries.put({
        romId: mergedRecord.id,
        data: scanned.normalizedBuffer,
        updatedAt: timestamp,
      });
      mergedRomRecords.push(mergedRecord);

      if (scanned.fileHandle) {
        const handleRecord = {
          id: handleIdForRom(mergedRecord.id),
          romId: mergedRecord.id,
          directoryId,
          relativePath: scanned.relativePath,
          fileName: scanned.fileName,
          fileHandle: scanned.fileHandle,
          updatedAt: timestamp,
        };

        try {
          await db.romHandles.put(handleRecord);
        } catch (error) {
          if (!isDataCloneError(error)) {
            throw error;
          }

          await db.romHandles.put({
            ...handleRecord,
            fileHandle: undefined,
          });
        }
      }
    }
  });

  return {
    directoryId,
    roms: mergedRomRecords,
  };
}

export async function pickAndIndexDirectory(): Promise<IndexDirectoryResult> {
  if (!supportsDirectoryPicker()) {
    throw new Error('Folder picker is not supported in this browser.');
  }

  const directoryHandle = await window.showDirectoryPicker?.({ mode: 'read' });
  if (!directoryHandle) {
    throw new Error('No directory selected.');
  }

  return indexDirectoryHandle(directoryHandle);
}

export async function reindexKnownDirectories(): Promise<number> {
  const directories = await db.directories.toArray();
  let indexedCount = 0;

  for (const directory of directories) {
    if (!directory.handle) {
      continue;
    }

    const granted = await ensurePermission(directory.handle);
    if (!granted) {
      continue;
    }

    await indexDirectoryHandle(directory.handle, directory.id);
    indexedCount += 1;
  }

  return indexedCount;
}

function dedupeImportedRomsByHash(scannedRoms: ScannedRom[]): ScannedRom[] {
  const deduped = new Map<string, ScannedRom>();
  for (const scanned of scannedRoms) {
    if (!deduped.has(scanned.hash)) {
      deduped.set(scanned.hash, scanned);
    }
  }
  return [...deduped.values()];
}

export async function importRomFilesDetailed(files: File[]): Promise<ImportRomFilesResult> {
  const scannedRoms = dedupeImportedRomsByHash(await scanImportedFiles(files));
  const romRecords: RomRecord[] = [];
  const timestamp = now();

  await db.transaction('rw', [db.roms, db.romBinaries], async () => {
    for (const scanned of scannedRoms) {
      const romId = `import:${scanned.hash}`;
      const romRecord = toRomRecord(scanned, romId);
      const previous = await db.roms.get(romId);
      const mergedRecord: RomRecord = {
        ...romRecord,
        addedAt: previous?.addedAt ?? romRecord.addedAt,
        lastPlayed: previous?.lastPlayed,
        favorite: previous?.favorite ?? romRecord.favorite,
      };
      romRecords.push(mergedRecord);

      await db.roms.put(mergedRecord);
      await db.romBinaries.put({
        romId,
        data: scanned.normalizedBuffer,
        updatedAt: timestamp,
      });
    }
  });

  return {
    imported: romRecords,
    skipped: Math.max(0, files.length - scannedRoms.length),
    total: files.length,
  };
}

export async function importRomFiles(files: File[]): Promise<RomRecord[]> {
  const result = await importRomFilesDetailed(files);
  return result.imported;
}

export async function listRoms(query?: CatalogQuery): Promise<RomRecord[]> {
  const search = query?.search?.trim().toLowerCase() ?? '';
  const sort = query?.sort ?? 'title';
  const favoritesOnly = query?.favoritesOnly ?? false;

  const roms = await db.roms.toArray();
  const searched =
    search.length === 0
      ? roms
      : roms.filter((rom) => {
          const target = `${rom.title} ${rom.relativePath ?? ''}`.toLowerCase();
          return target.includes(search);
        });

  const filtered = favoritesOnly ? searched.filter((rom) => rom.favorite) : searched;

  const sorted = [...filtered].sort((left, right) => {
    if (sort === 'favorite') {
      if (left.favorite !== right.favorite) {
        return Number(Boolean(right.favorite)) - Number(Boolean(left.favorite));
      }
      return left.title.localeCompare(right.title);
    }
    if (sort === 'lastPlayed') {
      return (right.lastPlayed ?? 0) - (left.lastPlayed ?? 0);
    }
    if (sort === 'size') {
      return right.size - left.size;
    }
    return left.title.localeCompare(right.title);
  });

  return sorted;
}

export async function setRomFavorite(romId: string, favorite?: boolean): Promise<void> {
  const rom = await db.roms.get(romId);
  if (!rom) {
    throw new Error('ROM was not found in catalog.');
  }

  await db.roms.put({
    ...rom,
    favorite: typeof favorite === 'boolean' ? favorite : !rom.favorite,
  });
}

export async function getRomById(romId: string): Promise<RomRecord | undefined> {
  return db.roms.get(romId);
}

export async function getRomArrayBuffer(romId: string): Promise<ArrayBuffer> {
  const rom = await db.roms.get(romId);
  if (!rom) {
    throw new Error('ROM was not found in catalog.');
  }

  if (rom.source === 'directory' && rom.handleRef?.romHandleId) {
    const romHandle = await db.romHandles.get(rom.handleRef.romHandleId);
    if (romHandle?.fileHandle) {
      const granted = await ensurePermission(romHandle.fileHandle);
      if (!granted) {
        throw new Error('Read permission for this ROM was denied. Re-index the folder and grant access.');
      }
      const file = await romHandle.fileHandle.getFile();
      return file.arrayBuffer();
    }
  }

  const binary = await db.romBinaries.get(romId);
  if (!binary) {
    throw new Error('ROM bytes are unavailable. Re-import this ROM or re-index its folder.');
  }

  return binary.data;
}

export async function markRomPlayed(romId: string): Promise<void> {
  const rom = await db.roms.get(romId);
  if (!rom) {
    return;
  }

  await db.roms.put({
    ...rom,
    lastPlayed: now(),
  });
}

export async function removeRomFromCatalog(romId: string): Promise<void> {
  await db.transaction('rw', [db.roms, db.romHandles, db.romBinaries, db.directories], async () => {
    const rom = await db.roms.get(romId);
    await db.roms.delete(romId);
    await db.romBinaries.delete(romId);
    await db.romHandles.delete(handleIdForRom(romId));

    if (rom?.directoryId) {
      const remaining = await db.roms.where('directoryId').equals(rom.directoryId).count();
      if (remaining === 0) {
        await db.directories.delete(rom.directoryId);
      }
    }
  });
}

export async function listProfilesForRom(romHash?: string): Promise<string[]> {
  const profiles = romHash
    ? await db.profiles.where('romHash').equals(romHash).toArray()
    : await db.profiles.toArray();

  return profiles
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((profile) => profile.profileId);
}
