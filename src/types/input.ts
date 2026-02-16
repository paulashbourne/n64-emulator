export const N64_DIGITAL_TARGETS = [
  'a',
  'b',
  'z',
  'start',
  'l',
  'r',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'c_up',
  'c_down',
  'c_left',
  'c_right',
] as const;

export const N64_ANALOG_TARGETS = ['analog_left', 'analog_right', 'analog_up', 'analog_down'] as const;

export const N64_MAPPING_ORDER = [
  'a',
  'b',
  'z',
  'start',
  'l',
  'r',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'c_up',
  'c_down',
  'c_left',
  'c_right',
  'analog_left',
  'analog_right',
  'analog_up',
  'analog_down',
] as const;

export type N64DigitalTarget = (typeof N64_DIGITAL_TARGETS)[number];
export type N64AnalogTarget = (typeof N64_ANALOG_TARGETS)[number];
export type N64ControlTarget = (typeof N64_MAPPING_ORDER)[number];

export type InputSource = 'gamepad_button' | 'gamepad_axis' | 'keyboard';
export type AxisDirection = 'negative' | 'positive';

export interface InputBinding {
  source: InputSource;
  code?: string;
  index?: number;
  gamepadIndex?: number;
  deviceId?: string;
  direction?: AxisDirection;
  threshold?: number;
  axisValue?: number;
  axisTolerance?: number;
}

export interface ControllerProfile {
  profileId: string;
  name: string;
  deviceId: string;
  romHash?: string;
  deadzone: number;
  bindings: Partial<Record<N64ControlTarget, InputBinding>>;
  updatedAt: number;
}

export interface N64InputState {
  buttons: Record<N64DigitalTarget, boolean>;
  stick: {
    x: number;
    y: number;
  };
}

export const DEFAULT_N64_INPUT_STATE: N64InputState = {
  buttons: {
    a: false,
    b: false,
    z: false,
    start: false,
    l: false,
    r: false,
    dpad_up: false,
    dpad_down: false,
    dpad_left: false,
    dpad_right: false,
    c_up: false,
    c_down: false,
    c_left: false,
    c_right: false,
  },
  stick: {
    x: 0,
    y: 0,
  },
};

export const CONTROL_LABELS: Record<N64ControlTarget, string> = {
  a: 'A',
  b: 'B',
  z: 'Z',
  start: 'Start',
  l: 'L',
  r: 'R',
  dpad_up: 'D-Pad Up',
  dpad_down: 'D-Pad Down',
  dpad_left: 'D-Pad Left',
  dpad_right: 'D-Pad Right',
  c_up: 'C-Up',
  c_down: 'C-Down',
  c_left: 'C-Left',
  c_right: 'C-Right',
  analog_left: 'Analog Left',
  analog_right: 'Analog Right',
  analog_up: 'Analog Up',
  analog_down: 'Analog Down',
};

export function isAnalogTarget(target: N64ControlTarget): target is N64AnalogTarget {
  return (N64_ANALOG_TARGETS as readonly string[]).includes(target);
}
