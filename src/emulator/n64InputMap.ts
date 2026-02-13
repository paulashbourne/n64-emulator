import type { N64ControlTarget } from '../types/input';

export const N64_ANALOG_MAX_VALUE = 0x7fff;

export const N64_TARGET_TO_INPUT_INDEX: Record<N64ControlTarget, number> = {
  a: 0,
  b: 1,
  z: 12,
  start: 3,
  l: 10,
  r: 11,
  dpad_up: 4,
  dpad_down: 5,
  dpad_left: 6,
  dpad_right: 7,
  c_up: 23,
  c_down: 22,
  c_left: 21,
  c_right: 20,
  analog_left: 17,
  analog_right: 16,
  analog_up: 19,
  analog_down: 18,
};
