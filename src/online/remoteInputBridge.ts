import { N64_ANALOG_MAX_VALUE, N64_TARGET_TO_INPUT_INDEX } from '../emulator/n64InputMap';
import { resolveEmulatorSimulateInput } from '../emulator/simulateInput';
import type { N64ControlTarget } from '../types/input';
import type { MultiplayerInputPayload } from '../types/multiplayer';

const REMOTE_ANALOG_DEADZONE = 0.03;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseRemoteInputPayload(payload: unknown): MultiplayerInputPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const parsed = payload as Partial<MultiplayerInputPayload>;
  if (parsed.kind === 'digital') {
    if (!isKnownControl(parsed.control) || typeof parsed.pressed !== 'boolean') {
      return null;
    }

    return {
      kind: 'digital',
      control: parsed.control,
      pressed: parsed.pressed,
    };
  }

  if (parsed.kind === 'analog') {
    if (typeof parsed.x !== 'number' || !Number.isFinite(parsed.x)) {
      return null;
    }
    if (typeof parsed.y !== 'number' || !Number.isFinite(parsed.y)) {
      return null;
    }

    return {
      kind: 'analog',
      x: clamp(parsed.x, -1, 1),
      y: clamp(parsed.y, -1, 1),
    };
  }

  return null;
}

export function describeRemoteInputPayload(payload: MultiplayerInputPayload | null | undefined): string {
  if (!payload) {
    return 'unknown input';
  }

  if (payload.kind === 'analog') {
    return `analog x ${payload.x.toFixed(2)} y ${payload.y.toFixed(2)}`;
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

  const simulateInput = resolveEmulatorSimulateInput(window.EJS_emulator);
  if (!simulateInput) {
    return false;
  }

  if (payload.kind === 'analog') {
    const x = Math.abs(payload.x) <= REMOTE_ANALOG_DEADZONE ? 0 : clamp(payload.x, -1, 1);
    const y = Math.abs(payload.y) <= REMOTE_ANALOG_DEADZONE ? 0 : clamp(payload.y, -1, 1);

    simulateInput(playerIndex, N64_TARGET_TO_INPUT_INDEX.analog_right, x > 0 ? x * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(playerIndex, N64_TARGET_TO_INPUT_INDEX.analog_left, x < 0 ? -x * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(playerIndex, N64_TARGET_TO_INPUT_INDEX.analog_up, y > 0 ? y * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(playerIndex, N64_TARGET_TO_INPUT_INDEX.analog_down, y < 0 ? -y * N64_ANALOG_MAX_VALUE : 0);
    return true;
  }

  const inputIndex = N64_TARGET_TO_INPUT_INDEX[payload.control];
  if (typeof inputIndex !== 'number') {
    return false;
  }

  simulateInput(playerIndex, inputIndex, payload.pressed ? 1 : 0);
  return true;
}

export function applyRemoteInputResetToHost(fromSlot: number): boolean {
  const playerIndex = slotToPlayerIndex(fromSlot);
  if (playerIndex === null || playerIndex < 1) {
    return false;
  }

  const simulateInput = resolveEmulatorSimulateInput(window.EJS_emulator);
  if (!simulateInput) {
    return false;
  }

  const uniqueInputIndexes = new Set<number>(Object.values(N64_TARGET_TO_INPUT_INDEX));
  for (const inputIndex of uniqueInputIndexes) {
    simulateInput(playerIndex, inputIndex, 0);
  }
  return true;
}
