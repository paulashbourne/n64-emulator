import type { ControllerProfile, N64ControlTarget } from '../types/input';
import { N64_TARGET_TO_INPUT_INDEX } from './n64InputMap';

export type EmulatorJsControls = Record<number, Record<number, { value?: number; value2?: string | number }>>;

const KEY_CODE_BY_CODE: Record<string, number> = {
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  Space: 32,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Minus: 189,
  Equal: 187,
  BracketLeft: 219,
  BracketRight: 221,
  Backslash: 220,
  Semicolon: 186,
  Quote: 222,
  Backquote: 192,
  Comma: 188,
  Period: 190,
  Slash: 191,
  IntlBackslash: 226,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  MetaLeft: 91,
  MetaRight: 92,
  CapsLock: 20,
  Insert: 45,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
};

const GAMEPAD_BUTTON_LABEL_BY_INDEX: Record<number, string> = {
  0: 'BUTTON_1',
  1: 'BUTTON_2',
  2: 'BUTTON_3',
  3: 'BUTTON_4',
  4: 'LEFT_TOP_SHOULDER',
  5: 'RIGHT_TOP_SHOULDER',
  6: 'LEFT_BOTTOM_SHOULDER',
  7: 'RIGHT_BOTTOM_SHOULDER',
  8: 'SELECT',
  9: 'START',
  10: 'LEFT_STICK',
  11: 'RIGHT_STICK',
  12: 'DPAD_UP',
  13: 'DPAD_DOWN',
  14: 'DPAD_LEFT',
  15: 'DPAD_RIGHT',
};

const GAMEPAD_AXIS_NAME_BY_INDEX: Record<number, string> = {
  0: 'LEFT_STICK_X',
  1: 'LEFT_STICK_Y',
  2: 'RIGHT_STICK_X',
  3: 'RIGHT_STICK_Y',
};

function gamepadButtonLabel(index: number): string {
  return GAMEPAD_BUTTON_LABEL_BY_INDEX[index] ?? `GAMEPAD_${index}`;
}

function gamepadAxisName(index: number): string {
  return GAMEPAD_AXIS_NAME_BY_INDEX[index] ?? `EXTRA_STICK_${index}`;
}

function axisDirectionForDiscreteValue(value: number): 'positive' | 'negative' | null {
  if (value >= 0.5) {
    return 'positive';
  }
  if (value <= -0.5) {
    return 'negative';
  }
  return null;
}

function connectedGamepadSelections(): string[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return [];
  }

  const gamepads = Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => Boolean(pad));
  return gamepads.map((pad) => `${pad.id}_${pad.index}`);
}

function ensurePrimaryGamepadSelection(
  emulator: {
    gamepadSelection?: string[];
    updateGamepadLabels?: () => void;
  },
): void {
  if (!Array.isArray(emulator.gamepadSelection)) {
    return;
  }

  const connectedSelections = connectedGamepadSelections();
  if (connectedSelections.length === 0) {
    return;
  }

  const currentSelection = emulator.gamepadSelection[0];
  if (typeof currentSelection === 'string' && connectedSelections.includes(currentSelection)) {
    return;
  }

  emulator.gamepadSelection[0] = connectedSelections[0];
  emulator.updateGamepadLabels?.();
}

function keyboardCodeToKeyCode(code?: string): number | undefined {
  if (!code) {
    return undefined;
  }

  if (KEY_CODE_BY_CODE[code] !== undefined) {
    return KEY_CODE_BY_CODE[code];
  }

  const keyMatch = code.match(/^Key([A-Z])$/);
  if (keyMatch) {
    return keyMatch[1].charCodeAt(0);
  }

  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) {
    return 48 + Number(digitMatch[1]);
  }

  const numpadMatch = code.match(/^Numpad([0-9])$/);
  if (numpadMatch) {
    return 96 + Number(numpadMatch[1]);
  }

  const functionMatch = code.match(/^F([1-9]|1[0-2])$/);
  if (functionMatch) {
    return 111 + Number(functionMatch[1]);
  }

  return undefined;
}

export function controllerProfileToEmulatorJsControls(profile?: ControllerProfile): EmulatorJsControls | undefined {
  if (!profile) {
    return undefined;
  }

  const playerControls: Record<number, { value?: number; value2?: string | number }> = {};

  for (const [target, inputIndex] of Object.entries(N64_TARGET_TO_INPUT_INDEX) as Array<[N64ControlTarget, number]>) {
    const binding = profile.bindings[target];
    if (!binding) {
      continue;
    }

    const entry: { value?: number; value2?: string | number } = {};

    if (binding.source === 'keyboard') {
      const keyCode = keyboardCodeToKeyCode(binding.code);
      if (keyCode !== undefined) {
        entry.value = keyCode;
      }
    }

    if (binding.source === 'gamepad_button' && typeof binding.index === 'number') {
      entry.value2 = gamepadButtonLabel(binding.index);
    }

    if (
      binding.source === 'gamepad_axis' &&
      typeof binding.index === 'number' &&
      binding.direction
    ) {
      const axisName = gamepadAxisName(binding.index);
      entry.value2 = `${axisName}:${binding.direction === 'positive' ? 1 : -1}`;
    }

    if (
      binding.source === 'gamepad_axis' &&
      typeof binding.index === 'number' &&
      typeof binding.axisValue === 'number'
    ) {
      const discreteDirection = axisDirectionForDiscreteValue(binding.axisValue);
      if (discreteDirection) {
        const axisName = gamepadAxisName(binding.index);
        entry.value2 = `${axisName}:${discreteDirection === 'positive' ? 1 : -1}`;
      }
    }

    if (entry.value !== undefined || entry.value2 !== undefined) {
      playerControls[inputIndex] = entry;
    }
  }

  return {
    0: playerControls,
    1: {},
    2: {},
    3: {},
  };
}

export function applyProfileToRunningEmulator(profile?: ControllerProfile): boolean {
  if (!profile || !window.EJS_emulator) {
    return false;
  }

  const controls = controllerProfileToEmulatorJsControls(profile);
  if (!controls) {
    return false;
  }

  const emulator = window.EJS_emulator;
  emulator.controls = {
    ...(emulator.controls ?? {}),
    0: controls[0],
  };
  ensurePrimaryGamepadSelection(emulator as { gamepadSelection?: string[]; updateGamepadLabels?: () => void });

  emulator.setupKeys?.();
  emulator.checkGamepadInputs?.();
  emulator.saveSettings?.();

  return true;
}
