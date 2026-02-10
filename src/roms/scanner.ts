import type { RomExtension, ScannedRom } from '../types/rom';

const MAGIC_BIG_ENDIAN = 0x80371240;
const MAGIC_LITTLE_ENDIAN = 0x40123780;
const MAGIC_BYTE_SWAPPED = 0x37804012;

export const ROM_EXTENSIONS: readonly RomExtension[] = ['.z64', '.n64', '.v64'];

export function getRomExtension(fileName: string): RomExtension | null {
  const lower = fileName.toLowerCase();
  const match = ROM_EXTENSIONS.find((extension) => lower.endsWith(extension));
  return match ?? null;
}

export function isSupportedRomFileName(fileName: string): boolean {
  return getRomExtension(fileName) !== null;
}

function readMagic(bytes: Uint8Array): number {
  return (
    (bytes[0] << 24) |
    (bytes[1] << 16) |
    (bytes[2] << 8) |
    bytes[3]
  ) >>> 0;
}

export function isValidN64RomData(normalizedData: Uint8Array): boolean {
  if (normalizedData.byteLength < 0x40) {
    return false;
  }
  return readMagic(normalizedData) === MAGIC_BIG_ENDIAN;
}

function swap16(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 2) {
    if (i + 1 >= source.length) {
      out[i] = source[i];
      continue;
    }
    out[i] = source[i + 1];
    out[i + 1] = source[i];
  }
  return out;
}

function swap32(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    out[i] = source[i + 3] ?? source[i] ?? 0;
    out[i + 1] = source[i + 2] ?? source[i + 1] ?? 0;
    out[i + 2] = source[i + 1] ?? source[i + 2] ?? 0;
    out[i + 3] = source[i] ?? source[i + 3] ?? 0;
  }
  return out;
}

export function normalizeRomByteOrder(buffer: ArrayBufferLike): Uint8Array {
  const source = new Uint8Array(buffer);
  if (source.length < 4) {
    return source.slice();
  }

  const magic = readMagic(source);

  if (magic === MAGIC_BIG_ENDIAN) {
    return source.slice();
  }

  if (magic === MAGIC_BYTE_SWAPPED) {
    return swap16(source);
  }

  if (magic === MAGIC_LITTLE_ENDIAN) {
    return swap32(source);
  }

  return source.slice();
}

function sanitizeAscii(byte: number): string {
  if (byte === 0) {
    return '';
  }
  if (byte >= 32 && byte <= 126) {
    return String.fromCharCode(byte);
  }
  return ' ';
}

export function parseRomTitle(normalizedData: Uint8Array): string {
  const titleStart = 0x20;
  const titleEnd = 0x34;
  const titleBytes = normalizedData.slice(titleStart, titleEnd);
  const rawTitle = Array.from(titleBytes, sanitizeAscii).join('');
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  return title || 'Unknown ROM';
}

export async function hashRom(normalizedData: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(normalizedData.byteLength);
  digestInput.set(normalizedData);
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

function inferRelativePath(file: File): string | undefined {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : undefined;
}

export async function scanRomFile(
  file: File,
  options?: {
    relativePath?: string;
    fileHandle?: FileSystemFileHandle;
  },
): Promise<ScannedRom | null> {
  const extension = getRomExtension(file.name);
  if (!extension) {
    return null;
  }

  const originalBuffer = await file.arrayBuffer();
  const normalizedData = normalizeRomByteOrder(originalBuffer);
  if (!isValidN64RomData(normalizedData)) {
    return null;
  }
  const hash = await hashRom(normalizedData);
  const title = parseRomTitle(normalizedData);

  return {
    hash,
    title,
    size: file.size,
    extension,
    relativePath: options?.relativePath ?? inferRelativePath(file),
    fileName: file.name,
    normalizedBuffer: toArrayBuffer(normalizedData),
    fileHandle: options?.fileHandle,
  };
}

export async function scanRomHandle(
  fileHandle: FileSystemFileHandle,
  relativePath?: string,
): Promise<ScannedRom | null> {
  const file = await fileHandle.getFile();
  return scanRomFile(file, { relativePath, fileHandle });
}

async function scanDirectoryRecursively(
  directoryHandle: FileSystemDirectoryHandle,
  currentPath: string,
  output: ScannedRom[],
): Promise<void> {
  const entries = (directoryHandle as unknown as {
    entries: () => AsyncIterable<[string, FileSystemHandle]>;
  }).entries();

  for await (const [entryName, entryHandle] of entries) {
    const nextPath = currentPath ? `${currentPath}/${entryName}` : entryName;

    if (entryHandle.kind === 'directory') {
      await scanDirectoryRecursively(entryHandle as FileSystemDirectoryHandle, nextPath, output);
      continue;
    }

    if (!isSupportedRomFileName(entryName)) {
      continue;
    }

    try {
      const scanned = await scanRomHandle(entryHandle as FileSystemFileHandle, nextPath);
      if (scanned) {
        output.push(scanned);
      }
    } catch {
      // Skip unreadable files and continue indexing the rest of the directory.
    }
  }
}

export async function scanDirectoryRoms(directoryHandle: FileSystemDirectoryHandle): Promise<ScannedRom[]> {
  const results: ScannedRom[] = [];
  await scanDirectoryRecursively(directoryHandle, '', results);
  return results;
}

export async function scanImportedFiles(files: File[]): Promise<ScannedRom[]> {
  const scanned = await Promise.allSettled(files.map((file) => scanRomFile(file)));
  return scanned
    .filter((result): result is PromiseFulfilledResult<ScannedRom | null> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((candidate): candidate is ScannedRom => candidate !== null);
}
