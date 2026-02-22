import {
  deleteCloudSave,
  getCloudSave,
  upsertCloudSaves,
} from '../online/authApi';
import { db } from '../storage/db';
import type { SaveSlotBlobRecord } from '../storage/db';
import type { CloudSaveRecord } from '../types/auth';
import type { SaveSlotRecord } from '../types/save';

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return '';
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

export async function getLocalSaveSlotBlob(slotId: string): Promise<SaveSlotBlobRecord | undefined> {
  const record = await db.saveSlotBlobs.get(slotId);
  if (!record) {
    return undefined;
  }
  return {
    ...record,
    data: record.data.slice(0),
  };
}

export async function upsertLocalSaveSlotBlob(input: {
  slotId: string;
  romHash: string;
  data: Uint8Array;
  updatedAt?: number;
  lastUploadedAt?: number;
}): Promise<SaveSlotBlobRecord> {
  const record: SaveSlotBlobRecord = {
    slotId: input.slotId,
    romHash: input.romHash,
    data: toArrayBuffer(input.data),
    updatedAt: input.updatedAt ?? Date.now(),
    lastUploadedAt: input.lastUploadedAt,
  };
  await db.saveSlotBlobs.put(record);
  return {
    ...record,
    data: record.data.slice(0),
  };
}

function toCloudSaveRecord(slot: SaveSlotRecord, blob: SaveSlotBlobRecord): CloudSaveRecord {
  return {
    romHash: slot.romHash,
    slotId: slot.slotId,
    gameKey: slot.gameKey,
    gameTitle: slot.gameTitle,
    slotName: slot.slotName,
    updatedAt: blob.updatedAt,
    byteLength: blob.data.byteLength,
    dataBase64: bytesToBase64(new Uint8Array(blob.data)),
  };
}

export async function persistRuntimeSaveForSlot(input: {
  slot: SaveSlotRecord;
  bytes: Uint8Array;
  authenticated: boolean;
}): Promise<void> {
  const updatedAt = Date.now();
  const local = await upsertLocalSaveSlotBlob({
    slotId: input.slot.slotId,
    romHash: input.slot.romHash,
    data: input.bytes,
    updatedAt,
  });

  if (!input.authenticated) {
    return;
  }

  await upsertCloudSaves([toCloudSaveRecord(input.slot, local)]);
  await db.saveSlotBlobs.update(input.slot.slotId, {
    lastUploadedAt: Date.now(),
  });
}

export async function reconcileSlotSaveWithCloud(input: {
  slot: SaveSlotRecord;
  authenticated: boolean;
}): Promise<{ bytesToApply?: Uint8Array }> {
  const local = await getLocalSaveSlotBlob(input.slot.slotId);
  if (!input.authenticated) {
    if (local?.data) {
      return {
        bytesToApply: new Uint8Array(local.data),
      };
    }
    return {};
  }

  const remote = await getCloudSave(input.slot.romHash, input.slot.slotId);
  if (remote && (!local || remote.updatedAt > local.updatedAt)) {
    const bytes = base64ToBytes(remote.dataBase64);
    await upsertLocalSaveSlotBlob({
      slotId: input.slot.slotId,
      romHash: input.slot.romHash,
      data: bytes,
      updatedAt: remote.updatedAt,
      lastUploadedAt: Date.now(),
    });
    return {
      bytesToApply: bytes,
    };
  }

  if (local && (!remote || local.updatedAt > remote.updatedAt)) {
    await upsertCloudSaves([toCloudSaveRecord(input.slot, local)]);
    await db.saveSlotBlobs.update(input.slot.slotId, {
      lastUploadedAt: Date.now(),
    });
    return {
      bytesToApply: new Uint8Array(local.data),
    };
  }

  if (local) {
    return {
      bytesToApply: new Uint8Array(local.data),
    };
  }

  return {};
}

export async function deleteSlotSaveEverywhere(input: {
  slot: SaveSlotRecord;
  authenticated: boolean;
}): Promise<void> {
  await db.saveSlotBlobs.delete(input.slot.slotId);
  if (!input.authenticated) {
    return;
  }
  await deleteCloudSave(input.slot.romHash, input.slot.slotId);
}

export async function backfillCloudSavesFromLocal(authenticated: boolean): Promise<void> {
  if (!authenticated) {
    return;
  }
  const [allBlobs, allSlots] = await Promise.all([
    db.saveSlotBlobs.toArray(),
    db.saveSlots.toArray(),
  ]);

  if (allBlobs.length === 0 || allSlots.length === 0) {
    return;
  }

  const slotsById = new Map(allSlots.map((slot) => [slot.slotId, slot]));
  const payload: CloudSaveRecord[] = [];
  for (const blob of allBlobs) {
    const slot = slotsById.get(blob.slotId);
    if (!slot) {
      continue;
    }
    payload.push(toCloudSaveRecord(slot, blob));
  }

  if (payload.length === 0) {
    return;
  }

  const batchSize = 40;
  for (let index = 0; index < payload.length; index += batchSize) {
    const batch = payload.slice(index, index + batchSize);
    await upsertCloudSaves(batch);
  }

  const uploadedAt = Date.now();
  await Promise.all(
    payload.map((item) =>
      db.saveSlotBlobs.update(item.slotId, {
        lastUploadedAt: uploadedAt,
      }),
    ),
  );
}
