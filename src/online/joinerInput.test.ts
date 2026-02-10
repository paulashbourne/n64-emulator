import {
  JOINER_KEY_TO_CONTROL,
  buildDigitalInputPayload,
  getPressedControlsFromGamepad,
} from './joinerInput';

describe('joiner input helpers', () => {
  test('maps expected keyboard keys to N64 controls', () => {
    expect(JOINER_KEY_TO_CONTROL.KeyX).toBe('a');
    expect(JOINER_KEY_TO_CONTROL.KeyC).toBe('b');
    expect(JOINER_KEY_TO_CONTROL.ArrowUp).toBe('dpad_up');
    expect(JOINER_KEY_TO_CONTROL.KeyL).toBe('c_right');
  });

  test('builds digital payload with expected shape', () => {
    expect(buildDigitalInputPayload('start', true)).toEqual({
      kind: 'digital',
      control: 'start',
      pressed: true,
    });
  });

  test('extracts pressed controls from gamepad buttons', () => {
    const controls = getPressedControlsFromGamepad({
      buttons: [
        { pressed: true, value: 1 },
        { pressed: false, value: 0.8 },
        { pressed: false, value: 0.2 },
        { pressed: false, value: 0 },
        { pressed: false, value: 0 },
        { pressed: false, value: 0 },
        { pressed: false, value: 0 },
        { pressed: false, value: 0 },
        { pressed: false, value: 0 },
        { pressed: true, value: 1 },
      ],
    });

    expect(controls.has('a')).toBe(true);
    expect(controls.has('b')).toBe(true);
    expect(controls.has('start')).toBe(true);
    expect(controls.has('z')).toBe(false);
  });
});
