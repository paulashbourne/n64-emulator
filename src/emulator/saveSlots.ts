import { matchRomCoverArt, normalizeCoverTitle } from '../roms/coverArtService';
import { db } from '../storage/db';
import type { RomRecord } from '../types/rom';
import type { SaveGameIdentity, SaveGameSummary, SaveSlotRecord } from '../types/save';

const DEFAULT_SLOT_NAME = 'Main Save';

function now(): number {
  return Date.now();
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'unknown';
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripTitleNoise(raw: string): string {
  let value = normalizeCoverTitle(raw);
  value = value
    .replace(/\b(rev|revision)\s*[a-z0-9]+\b/g, ' ')
    .replace(/\b(v|ver|version)\s*\d+(\.\d+)?\b/g, ' ')
    .replace(/\b(usa|us|u|europe|eur|pal|japan|jpn|jp|ntsc)\b/g, ' ')
    .replace(/\b(beta|proto|prototype|demo|sample)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value;
}

function createSlotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `slot:${crypto.randomUUID()}`;
  }
  return `slot:${Math.random().toString(36).slice(2, 12)}`;
}

function cloneRecord(slot: SaveSlotRecord): SaveSlotRecord {
  return {
    ...slot,
  };
}

function sortSlots(slots: SaveSlotRecord[]): SaveSlotRecord[] {
  return [...slots].sort((left, right) => {
    const rightScore = right.updatedAt ?? right.createdAt;
    const leftScore = left.updatedAt ?? left.createdAt;
    return rightScore - leftScore;
  });
}

export function normalizeSlotName(value: string | undefined): string {
  const normalized = compactWhitespace(value ?? '');
  if (!normalized) {
    return DEFAULT_SLOT_NAME;
  }
  return normalized.slice(0, 48);
}

export function resolveSaveGameIdentity(rom: Pick<RomRecord, 'title' | 'relativePath'>): SaveGameIdentity {
  const cover = matchRomCoverArt(rom);
  if (cover) {
    const normalized = normalizeCoverTitle(cover.title);
    const key = `game:${slugify(normalized)}`;
    return {
      gameKey: key,
      displayTitle: cover.title,
      normalizedTitle: normalized,
      source: 'cover',
    };
  }

  const fallbackTitle = compactWhitespace(rom.title) || 'Unknown Game';
  const normalized = stripTitleNoise(fallbackTitle) || normalizeCoverTitle(fallbackTitle) || 'unknown-game';
  const key = `game:${slugify(normalized)}`;

  return {
    gameKey: key,
    displayTitle: fallbackTitle,
    normalizedTitle: normalized,
    source: 'rom_title',
  };
}

export function buildEmulatorGameId(gameKey: string, slotId: string): string {
  const safeGame = slugify(gameKey.replace(/^game:/, ''));
  const safeSlot = slugify(slotId.replace(/^slot:/, ''));
  return `warpdeck64:${safeGame}:slot:${safeSlot}`;
}

export async function listSaveSlotsForGame(gameKey: string): Promise<SaveSlotRecord[]> {
  const rows = await db.saveSlots.where('gameKey').equals(gameKey).toArray();
  return sortSlots(rows).map(cloneRecord);
}

export async function listAllSaveSlots(): Promise<SaveSlotRecord[]> {
  const rows = await db.saveSlots.toArray();
  return sortSlots(rows).map(cloneRecord);
}

export async function getSaveSlot(slotId: string): Promise<SaveSlotRecord | undefined> {
  const slot = await db.saveSlots.get(slotId);
  return slot ? cloneRecord(slot) : undefined;
}

export async function createSaveSlot(
  identity: SaveGameIdentity,
  options?: { slotName?: string; slotId?: string },
): Promise<SaveSlotRecord> {
  const createdAt = now();
  const slot: SaveSlotRecord = {
    slotId: options?.slotId ?? createSlotId(),
    gameKey: identity.gameKey,
    gameTitle: identity.displayTitle,
    slotName: normalizeSlotName(options?.slotName),
    createdAt,
    updatedAt: createdAt,
  };

  await db.saveSlots.put(slot);
  return cloneRecord(slot);
}

export async function ensurePrimarySaveSlot(identity: SaveGameIdentity): Promise<SaveSlotRecord> {
  const existing = await listSaveSlotsForGame(identity.gameKey);
  if (existing.length > 0) {
    return existing[0];
  }
  return createSaveSlot(identity, { slotName: DEFAULT_SLOT_NAME });
}

export async function chooseBootSaveSlot(
  identity: SaveGameIdentity,
  options?: {
    requestedSlotId?: string;
  },
): Promise<{ activeSlot: SaveSlotRecord; slots: SaveSlotRecord[] }> {
  const slots = await listSaveSlotsForGame(identity.gameKey);
  const requestedSlotId = options?.requestedSlotId?.trim();

  if (slots.length === 0) {
    const created = await createSaveSlot(identity, { slotName: DEFAULT_SLOT_NAME });
    return {
      activeSlot: created,
      slots: [created],
    };
  }

  if (requestedSlotId) {
    const requested = slots.find((slot) => slot.slotId === requestedSlotId);
    if (requested) {
      return { activeSlot: requested, slots };
    }
  }

  return {
    activeSlot: slots[0],
    slots,
  };
}

export async function markSaveSlotPlayed(slotId: string): Promise<void> {
  const timestamp = now();
  await db.saveSlots.update(slotId, {
    lastPlayedAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function markSaveSlotSaved(slotId: string): Promise<void> {
  const timestamp = now();
  await db.saveSlots.update(slotId, {
    lastSavedAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function clearSaveSlotProgress(slotId: string): Promise<void> {
  const timestamp = now();
  await db.saveSlots.update(slotId, {
    lastPlayedAt: undefined,
    lastSavedAt: undefined,
    updatedAt: timestamp,
  });
}

export async function renameSaveSlot(slotId: string, slotName: string): Promise<void> {
  await db.saveSlots.update(slotId, {
    slotName: normalizeSlotName(slotName),
    updatedAt: now(),
  });
}

export async function touchSaveSlot(slotId: string): Promise<void> {
  await db.saveSlots.update(slotId, {
    updatedAt: now(),
  });
}

export async function deleteSaveSlot(slotId: string): Promise<void> {
  await db.saveSlots.delete(slotId);
}

export async function deleteSaveSlotsForGame(gameKey: string): Promise<number> {
  const slots = await db.saveSlots.where('gameKey').equals(gameKey).toArray();
  if (slots.length === 0) {
    return 0;
  }
  await db.saveSlots.bulkDelete(slots.map((slot) => slot.slotId));
  return slots.length;
}

export async function listSaveSummariesByGame(
  gameKeys?: string[],
): Promise<Map<string, SaveGameSummary>> {
  const rows =
    gameKeys && gameKeys.length > 0
      ? (await Promise.all(gameKeys.map((gameKey) => db.saveSlots.where('gameKey').equals(gameKey).toArray()))).flat()
      : await db.saveSlots.toArray();

  const grouped = new Map<string, SaveSlotRecord[]>();
  for (const slot of rows) {
    const list = grouped.get(slot.gameKey);
    if (list) {
      list.push(slot);
    } else {
      grouped.set(slot.gameKey, [slot]);
    }
  }

  const summaries = new Map<string, SaveGameSummary>();
  for (const [gameKey, slots] of grouped.entries()) {
    const ordered = sortSlots(slots);
    const primary = ordered[0];
    summaries.set(gameKey, {
      gameKey,
      gameTitle: primary.gameTitle,
      slotCount: ordered.length,
      lastPlayedAt: primary.lastPlayedAt,
      lastSavedAt: primary.lastSavedAt,
      primarySlotId: primary.slotId,
      primarySlotName: primary.slotName,
    });
  }

  return summaries;
}
