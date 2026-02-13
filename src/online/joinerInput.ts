import type { N64ControlTarget } from '../types/input';
import type { MultiplayerAnalogInputPayload, MultiplayerDigitalInputPayload } from '../types/multiplayer';

export const JOINER_KEY_TO_CONTROL: Record<string, N64ControlTarget> = {
  KeyX: 'a',
  KeyC: 'b',
  KeyZ: 'z',
  Enter: 'start',
  KeyQ: 'l',
  KeyE: 'r',
  ArrowUp: 'dpad_up',
  ArrowDown: 'dpad_down',
  ArrowLeft: 'dpad_left',
  ArrowRight: 'dpad_right',
  KeyI: 'c_up',
  KeyK: 'c_down',
  KeyJ: 'c_left',
  KeyL: 'c_right',
};

export const JOINER_GAMEPAD_BUTTON_TO_CONTROL: Record<number, N64ControlTarget> = {
  0: 'a',
  1: 'b',
  2: 'z',
  4: 'l',
  5: 'r',
  9: 'start',
  12: 'dpad_up',
  13: 'dpad_down',
  14: 'dpad_left',
  15: 'dpad_right',
};

export interface JoinerGamepadSnapshot {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
}

export function buildDigitalInputPayload(control: N64ControlTarget, pressed: boolean): MultiplayerDigitalInputPayload {
  return {
    kind: 'digital',
    control,
    pressed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildAnalogInputPayload(x: number, y: number): MultiplayerAnalogInputPayload {
  return {
    kind: 'analog',
    x: clamp(x, -1, 1),
    y: clamp(y, -1, 1),
  };
}

export function getPressedControlsFromGamepad(gamepad?: JoinerGamepadSnapshot | null): Set<N64ControlTarget> {
  const pressed = new Set<N64ControlTarget>();
  if (!gamepad) {
    return pressed;
  }

  for (const [buttonIndexString, control] of Object.entries(JOINER_GAMEPAD_BUTTON_TO_CONTROL)) {
    const buttonIndex = Number(buttonIndexString);
    const button = gamepad.buttons[buttonIndex];
    if (button?.pressed || (button?.value ?? 0) >= 0.5) {
      pressed.add(control);
    }
  }

  return pressed;
}
