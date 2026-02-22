export interface SaveSlotRecord {
  slotId: string;
  gameKey: string;
  gameTitle: string;
  romHash: string;
  slotName: string;
  createdAt: number;
  updatedAt: number;
  lastPlayedAt?: number;
  lastSavedAt?: number;
}

export interface SaveGameIdentity {
  gameKey: string;
  displayTitle: string;
  normalizedTitle: string;
  romHash: string;
  source: 'cover' | 'rom_title';
}

export interface SaveGameSummary {
  gameKey: string;
  gameTitle: string;
  slotCount: number;
  lastPlayedAt?: number;
  lastSavedAt?: number;
  primarySlotId?: string;
  primarySlotName?: string;
}
