import { controllerProfileToEmulatorJsControls } from './emulatorJsControls';
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
    expect(controls?.[0][20]?.value2).toBe('2:-1');
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
});
