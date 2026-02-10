import {
  getRomExtension,
  hashRom,
  isValidN64RomData,
  isSupportedRomFileName,
  normalizeRomByteOrder,
  parseRomTitle,
  scanDirectoryRoms,
  scanImportedFiles,
} from './scanner';

function buildCanonicalRom(title: string): Uint8Array {
  const rom = new Uint8Array(0x80);
  rom[0] = 0x80;
  rom[1] = 0x37;
  rom[2] = 0x12;
  rom[3] = 0x40;

  const titleBytes = new TextEncoder().encode(title.padEnd(20, ' ').slice(0, 20));
  rom.set(titleBytes, 0x20);

  for (let index = 0x34; index < rom.length; index += 1) {
    rom[index] = index % 251;
  }

  return rom;
}

function toLittleEndianWords(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 4) {
    out[index] = source[index + 3] ?? 0;
    out[index + 1] = source[index + 2] ?? 0;
    out[index + 2] = source[index + 1] ?? 0;
    out[index + 3] = source[index] ?? 0;
  }
  return out;
}

function toByteSwappedWords(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 2) {
    out[index] = source[index + 1] ?? 0;
    out[index + 1] = source[index] ?? 0;
  }
  return out;
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

describe('ROM scanner utilities', () => {
  test('detects supported extensions', () => {
    expect(isSupportedRomFileName('mario.z64')).toBe(true);
    expect(isSupportedRomFileName('zelda.N64')).toBe(true);
    expect(isSupportedRomFileName('banjo.v64')).toBe(true);
    expect(isSupportedRomFileName('readme.txt')).toBe(false);
    expect(getRomExtension('demo.v64')).toBe('.v64');
  });

  test('parses title from canonical bytes', () => {
    const canonical = buildCanonicalRom('SUPER MARIO 64');
    expect(parseRomTitle(canonical)).toBe('SUPER MARIO 64');
  });

  test('produces stable hash after byte-order normalization', async () => {
    const canonical = buildCanonicalRom('STAR FOX 64');
    const little = toLittleEndianWords(canonical);
    const byteswapped = toByteSwappedWords(canonical);

    const canonicalNormalized = normalizeRomByteOrder(canonical.buffer);
    const littleNormalized = normalizeRomByteOrder(little.buffer);
    const byteswappedNormalized = normalizeRomByteOrder(byteswapped.buffer);

    const canonicalHash = await hashRom(canonicalNormalized);
    const littleHash = await hashRom(littleNormalized);
    const byteswappedHash = await hashRom(byteswappedNormalized);

    expect(canonicalHash).toBe(littleHash);
    expect(canonicalHash).toBe(byteswappedHash);
  });

  test('normalization is idempotent for already-normalized rom data', () => {
    const canonical = buildCanonicalRom('MARIO TENNIS');
    const normalizedOnce = normalizeRomByteOrder(canonical.buffer);
    const normalizedTwice = normalizeRomByteOrder(normalizedOnce.buffer);

    expect(Array.from(normalizedTwice)).toEqual(Array.from(normalizedOnce));
  });

  test('rejects invalid or truncated rom payloads', () => {
    const invalid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const normalizedInvalid = normalizeRomByteOrder(invalid.buffer);
    expect(isValidN64RomData(normalizedInvalid)).toBe(false);

    const truncatedValidHeader = new Uint8Array([0x80, 0x37, 0x12, 0x40, 0, 0, 0, 0]);
    const normalizedTruncated = normalizeRomByteOrder(truncatedValidHeader.buffer);
    expect(isValidN64RomData(normalizedTruncated)).toBe(false);
  });

  test('scanImportedFiles skips unreadable files while keeping valid roms', async () => {
    const valid = createMockFile('valid.z64', buildCanonicalRom('VALID ROM'));
    const unreadable = {
      name: 'broken.z64',
      size: 128,
      type: 'application/octet-stream',
      arrayBuffer: async () => {
        throw new Error('Read failed');
      },
    } as unknown as File;

    const scanned = await scanImportedFiles([valid, unreadable]);
    expect(scanned).toHaveLength(1);
    expect(scanned[0].title).toBe('VALID ROM');
  });

  test('scanDirectoryRoms skips unreadable entries and continues recursively', async () => {
    const validFile = createMockFile('good.z64', buildCanonicalRom('GOOD ROM'));
    const validHandle = {
      kind: 'file',
      name: 'good.z64',
      getFile: async () => validFile,
    } as unknown as FileSystemFileHandle;

    const unreadableHandle = {
      kind: 'file',
      name: 'bad.z64',
      getFile: async () => {
        throw new Error('No access');
      },
    } as unknown as FileSystemFileHandle;

    const nestedDirectory = {
      kind: 'directory',
      name: 'nested',
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        yield ['good.z64', validHandle as unknown as FileSystemHandle];
      },
    } as unknown as FileSystemDirectoryHandle;

    const rootDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        yield ['bad.z64', unreadableHandle as unknown as FileSystemHandle];
        yield ['nested', nestedDirectory as unknown as FileSystemHandle];
      },
    } as unknown as FileSystemDirectoryHandle;

    const scanned = await scanDirectoryRoms(rootDirectory);
    expect(scanned).toHaveLength(1);
    expect(scanned[0].title).toBe('GOOD ROM');
    expect(scanned[0].relativePath).toBe('nested/good.z64');
  });
});
