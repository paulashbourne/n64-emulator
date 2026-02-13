import {
  JOINER_KEY_TO_CONTROL,
  buildAnalogInputPayload,
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

  test('builds clamped analog payload', () => {
    expect(buildAnalogInputPayload(0.25, -0.8)).toEqual({
      kind: 'analog',
      x: 0.25,
      y: -0.8,
    });

    expect(buildAnalogInputPayload(5, -4)).toEqual({
      kind: 'analog',
      x: 1,
      y: -1,
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
