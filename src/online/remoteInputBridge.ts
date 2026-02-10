import { N64_TARGET_TO_INPUT_INDEX } from '../emulator/n64InputMap';
import type { N64ControlTarget } from '../types/input';
import type { MultiplayerInputPayload } from '../types/multiplayer';

interface ApplyRemoteInputArgs {
  fromSlot: number;
  payload: MultiplayerInputPayload | null | undefined;
}

function slotToPlayerIndex(slot: number): number | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    return null;
  }
  return slot - 1;
}

function isKnownControl(control: unknown): control is N64ControlTarget {
  return typeof control === 'string' && control in N64_TARGET_TO_INPUT_INDEX;
}

export function parseRemoteInputPayload(payload: unknown): MultiplayerInputPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const parsed = payload as Partial<MultiplayerInputPayload>;
  if (parsed.kind !== 'digital') {
    return null;
  }

  if (!isKnownControl(parsed.control) || typeof parsed.pressed !== 'boolean') {
    return null;
  }

  return {
    kind: 'digital',
    control: parsed.control,
    pressed: parsed.pressed,
  };
}

export function describeRemoteInputPayload(payload: MultiplayerInputPayload | null | undefined): string {
  if (!payload) {
    return 'unknown input';
  }

  return `${payload.control} ${payload.pressed ? 'down' : 'up'}`;
}

export function applyRemoteInputPayloadToHost({ fromSlot, payload }: ApplyRemoteInputArgs): boolean {
  if (!payload) {
    return false;
  }

  const playerIndex = slotToPlayerIndex(fromSlot);
  if (playerIndex === null || playerIndex < 1) {
    return false;
  }

  const inputIndex = N64_TARGET_TO_INPUT_INDEX[payload.control];
  if (typeof inputIndex !== 'number') {
    return false;
  }

  const emulator = window.EJS_emulator;
  const simulateInput = emulator?.gameManager?.simulateInput ?? emulator?.gameManager?.functions?.simulateInput;
  if (typeof simulateInput !== 'function') {
    return false;
  }

  simulateInput(playerIndex, inputIndex, payload.pressed ? 1 : 0);
  return true;
}
