export type RomExtension = '.z64' | '.n64' | '.v64';
export type RomSource = 'directory' | 'import';

export interface RomHandleRef {
  romHandleId: string;
  directoryId?: string;
  relativePath?: string;
}

export interface RomRecord {
  id: string;
  hash: string;
  title: string;
  size: number;
  extension: RomExtension;
  source: RomSource;
  favorite: boolean;
  lastPlayed?: number;
  addedAt: number;
  directoryId?: string;
  relativePath?: string;
  handleRef?: RomHandleRef;
}

export interface DirectoryRecord {
  id: string;
  name: string;
  handle?: FileSystemDirectoryHandle;
  addedAt: number;
  lastIndexedAt: number;
}

export interface RomHandleRecord {
  id: string;
  romId: string;
  directoryId?: string;
  relativePath?: string;
  fileName: string;
  fileHandle?: FileSystemFileHandle;
  updatedAt: number;
}

export interface RomBinaryRecord {
  romId: string;
  data: ArrayBuffer;
  updatedAt: number;
}

export interface ScannedRom {
  hash: string;
  title: string;
  size: number;
  extension: RomExtension;
  relativePath?: string;
  fileName: string;
  normalizedBuffer: ArrayBuffer;
  fileHandle?: FileSystemFileHandle;
}
