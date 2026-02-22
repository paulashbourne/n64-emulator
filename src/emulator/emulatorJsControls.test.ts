import { vi } from 'vitest';

import { applyProfileToRunningEmulator, controllerProfileToEmulatorJsControls } from './emulatorJsControls';
import type { ControllerProfile } from '../types/input';

function makeProfile(overrides?: Partial<ControllerProfile>): ControllerProfile {
  return {
    profileId: 'profile:test',
    name: 'Test Profile',
    deviceId: 'Pad 1',
    deadzone: 0.2,
    bindings: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('emulatorJsControls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('maps punctuation keyboard codes into EmulatorJS key codes', () => {
    const profile = makeProfile({
      bindings: {
        a: { source: 'keyboard', code: 'Minus' },
        b: { source: 'keyboard', code: 'BracketLeft' },
      },
    });

    const controls = controllerProfileToEmulatorJsControls(profile);

    expect(controls?.[0][0]?.value).toBe(189);
    expect(controls?.[0][1]?.value).toBe(219);
  });

  test('encodes gamepad axis bindings with explicit direction', () => {
    const profile = makeProfile({
      bindings: {
        c_right: {
          source: 'gamepad_axis',
          index: 2,
          direction: 'negative',
        },
      },
    });

    const controls = controllerProfileToEmulatorJsControls(profile);
    expect(controls?.[0][20]?.value2).toBe('RIGHT_STICK_X:-1');
  });

  test('encodes gamepad button bindings with EmulatorJS button labels', () => {
    const profile = makeProfile({
      bindings: {
        a: {
          source: 'gamepad_button',
          index: 0,
        },
      },
    });

    const controls = controllerProfileToEmulatorJsControls(profile);
    expect(controls?.[0][0]?.value2).toBe('BUTTON_1');
  });

  test('encodes strong discrete axis-value bindings into EmulatorJS axis labels', () => {
    const profile = makeProfile({
      bindings: {
        c_left: {
          source: 'gamepad_axis',
          index: 2,
          axisValue: -1,
          axisTolerance: 0.12,
        },
      },
    });

    const controls = controllerProfileToEmulatorJsControls(profile);
    expect(controls?.[0][21]?.value2).toBe('RIGHT_STICK_X:-1');
  });

  test('skips unknown keyboard codes instead of writing invalid bindings', () => {
    const profile = makeProfile({
      bindings: {
        start: { source: 'keyboard', code: 'UnknownWeirdCode' },
      },
    });

    const controls = controllerProfileToEmulatorJsControls(profile);
    expect(controls?.[0][3]).toBeUndefined();
  });

  test('auto-selects the first connected gamepad for player 1 when selection is empty', () => {
    const profile = makeProfile({
      bindings: {
        a: {
          source: 'gamepad_button',
          index: 0,
        },
      },
    });

    Object.defineProperty(navigator, 'getGamepads', {
      value: () => [{ id: 'Pad One', index: 2 }],
      writable: true,
      configurable: true,
    });

    const setupKeys = vi.fn();
    const checkGamepadInputs = vi.fn();
    const saveSettings = vi.fn();
    const updateGamepadLabels = vi.fn();

    const emulatorWithSelection = {
      controls: { 0: {}, 1: {}, 2: {}, 3: {} },
      gamepadSelection: ['', '', '', ''],
      setupKeys,
      checkGamepadInputs,
      saveSettings,
      updateGamepadLabels,
    };
    window.EJS_emulator = emulatorWithSelection as unknown as typeof window.EJS_emulator;

    const applied = applyProfileToRunningEmulator(profile);

    expect(applied).toBe(true);
    expect(emulatorWithSelection.gamepadSelection[0]).toBe('Pad One_2');
    expect(updateGamepadLabels).toHaveBeenCalled();
    expect(setupKeys).toHaveBeenCalled();
    expect(checkGamepadInputs).toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalled();
  });
});
