import { db } from '../storage/db';
import {
  getRomArrayBuffer,
  importRomFilesDetailed,
  importRomFiles,
  indexDirectoryHandle,
  listRoms,
  markRomPlayed,
  removeRomFromCatalog,
  setRomFavorite,
} from './catalogService';

function createRomBytes(title: string): Uint8Array {
  const bytes = new Uint8Array(0x80);
  bytes[0] = 0x80;
  bytes[1] = 0x37;
  bytes[2] = 0x12;
  bytes[3] = 0x40;
  const encodedTitle = new TextEncoder().encode(title.padEnd(20, ' '));
  bytes.set(encodedTitle.slice(0, 20), 0x20);
  for (let i = 0x34; i < bytes.length; i += 1) {
    bytes[i] = (i * 13) % 255;
  }
  return bytes;
}

function createMockFile(name: string, bytes: Uint8Array): File {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    arrayBuffer: async () => data.slice(0),
  } as unknown as File;
}

describe('catalog service', () => {
  beforeEach(async () => {
    await db.transaction('rw', [db.roms, db.romBinaries, db.romHandles, db.directories], async () => {
      await db.roms.clear();
      await db.romBinaries.clear();
      await db.romHandles.clear();
      await db.directories.clear();
    });
  });

  test('imports files and lists them from catalog', async () => {
    const file = createMockFile('mariokart.z64', createRomBytes('MARIO KART 64'));

    await importRomFiles([file]);
    const roms = await listRoms();

    expect(roms).toHaveLength(1);
    expect(roms[0].title).toBe('MARIO KART 64');

    const buffer = await getRomArrayBuffer(roms[0].id);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test('indexes directory handles and refreshes ROM metadata', async () => {
    const file = createMockFile('waverace.z64', createRomBytes('WAVE RACE 64'));

    const fileHandle = {
      kind: 'file',
      name: file.name,
      getFile: async () => file,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    } as unknown as FileSystemFileHandle;

    const directoryHandle = {
      kind: 'directory',
      name: 'roms',
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        yield [file.name, fileHandle as unknown as FileSystemHandle];
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    } as unknown as FileSystemDirectoryHandle;

    await indexDirectoryHandle(directoryHandle);

    const roms = await listRoms();
    expect(roms).toHaveLength(1);
    expect(roms[0].source).toBe('directory');
    expect(roms[0].relativePath).toBe('waverace.z64');
  });

  test('removes rom and associated binary records from catalog', async () => {
    const file = createMockFile('starfox.z64', createRomBytes('STAR FOX 64'));
    await importRomFiles([file]);

    const romsBefore = await listRoms();
    expect(romsBefore).toHaveLength(1);

    await removeRomFromCatalog(romsBefore[0].id);

    const romsAfter = await listRoms();
    expect(romsAfter).toHaveLength(0);

    await expect(getRomArrayBuffer(romsBefore[0].id)).rejects.toThrow('ROM was not found in catalog.');
  });

  test('ignores corrupt rom payloads during import', async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const invalidFile = createMockFile('bad.z64', invalidBytes);

    const imported = await importRomFiles([invalidFile]);
    expect(imported).toHaveLength(0);

    const roms = await listRoms();
    expect(roms).toHaveLength(0);
  });

  test('preserves lastPlayed when importing the same rom hash again', async () => {
    const file = createMockFile('pilotwings.z64', createRomBytes('PILOTWINGS 64'));
    await importRomFiles([file]);

    const [original] = await listRoms();
    expect(original).toBeDefined();

    await markRomPlayed(original.id);
    const [played] = await listRoms({ sort: 'lastPlayed' });
    expect(typeof played.lastPlayed).toBe('number');

    await importRomFiles([file]);
    const [afterReimport] = await listRoms({ sort: 'lastPlayed' });
    expect(afterReimport.id).toBe(original.id);
    expect(afterReimport.lastPlayed).toBe(played.lastPlayed);
  });

  test('preserves lastPlayed when reindexing a directory rom', async () => {
    const file = createMockFile('fzero.z64', createRomBytes('F-ZERO X'));

    const fileHandle = {
      kind: 'file',
      name: file.name,
      getFile: async () => file,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    } as unknown as FileSystemFileHandle;

    const directoryHandle = {
      kind: 'directory',
      name: 'roms',
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        yield [file.name, fileHandle as unknown as FileSystemHandle];
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    } as unknown as FileSystemDirectoryHandle;

    const firstIndex = await indexDirectoryHandle(directoryHandle);
    const [indexedRom] = firstIndex.roms;
    await markRomPlayed(indexedRom.id);
    const [played] = await listRoms({ sort: 'lastPlayed' });
    expect(played.lastPlayed).toBeDefined();

    await indexDirectoryHandle(directoryHandle, firstIndex.directoryId);
    const [afterReindex] = await listRoms({ sort: 'lastPlayed' });
    expect(afterReindex.id).toBe(indexedRom.id);
    expect(afterReindex.lastPlayed).toBe(played.lastPlayed);
  });

  test('sorts roms by size when requested', async () => {
    const small = createMockFile('small.z64', createRomBytes('SMALL ROM'));
    const largeBytes = new Uint8Array(createRomBytes('LARGE ROM').length + 64);
    largeBytes.set(createRomBytes('LARGE ROM'));
    const large = createMockFile('large.z64', largeBytes);

    await importRomFiles([small, large]);
    const sorted = await listRoms({ sort: 'size' });
    expect(sorted).toHaveLength(2);
    expect(sorted[0].size).toBeGreaterThanOrEqual(sorted[1].size);
  });

  test('supports favorites-only filtering and favorite-first sorting', async () => {
    const alpha = createMockFile('alpha.z64', createRomBytes('ALPHA ROM'));
    const beta = createMockFile('beta.z64', createRomBytes('BETA ROM'));
    await importRomFiles([alpha, beta]);

    const allByTitle = await listRoms({ sort: 'title' });
    expect(allByTitle).toHaveLength(2);
    expect(allByTitle[0].favorite).toBe(false);
    expect(allByTitle[1].favorite).toBe(false);

    await setRomFavorite(allByTitle[1].id, true);

    const favoritesOnly = await listRoms({ favoritesOnly: true });
    expect(favoritesOnly).toHaveLength(1);
    expect(favoritesOnly[0].title).toBe('BETA ROM');
    expect(favoritesOnly[0].favorite).toBe(true);

    const favoriteSorted = await listRoms({ sort: 'favorite' });
    expect(favoriteSorted[0].favorite).toBe(true);
  });

  test('deduplicates same-rom imports by hash in a single batch', async () => {
    const sharedBytes = createRomBytes('DUPLICATE BATCH');
    const first = createMockFile('dup-a.z64', sharedBytes);
    const second = createMockFile('dup-b.z64', sharedBytes);

    const result = await importRomFilesDetailed([first, second]);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toBe(1);

    const roms = await listRoms();
    expect(roms).toHaveLength(1);
    expect(roms[0].title).toBe('DUPLICATE BATCH');
  });
});
