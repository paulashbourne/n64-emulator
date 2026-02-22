import { createKeyboardPresetBindings } from './mappingWizard';
import type { ControllerProfile, InputBinding, N64ControlTarget } from '../types/input';

type FaceLayout = 'xbox' | 'nintendo';

export const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';
export const PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID = 'profile:gamepad-switch';
export const PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID = 'profile:gamepad-xbox-series';
export const PRECONFIGURED_BACKBONE_PROFILE_TEMPLATE_ID = 'profile:gamepad-backbone';
export const PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID = 'profile:gamepad-8bitdo-64';

export interface PreconfiguredGamepadProfileTemplate {
  templateId: string;
  name: string;
  deviceId: string;
  deadzone: number;
}

export const PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES: readonly PreconfiguredGamepadProfileTemplate[] = [
  {
    templateId: PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID,
    name: 'Nintendo Switch Controller',
    deviceId: 'preset-switch-controller',
    deadzone: 0.2,
  },
  {
    templateId: PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID,
    name: 'Xbox Series X|S Controller',
    deviceId: 'preset-xbox-series-controller',
    deadzone: 0.2,
  },
  {
    templateId: PRECONFIGURED_BACKBONE_PROFILE_TEMPLATE_ID,
    name: 'Backbone Controller (iPhone)',
    deviceId: 'preset-backbone-controller',
    deadzone: 0.2,
  },
  {
    templateId: PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
    name: '8BitDo 64 Bluetooth Controller',
    deviceId: 'preset-8bitdo-64-controller',
    deadzone: 0.2,
  },
];

function button(index: number): InputBinding {
  return {
    source: 'gamepad_button',
    index,
  };
}

function axis(index: number, direction: 'negative' | 'positive', threshold = 0.3): InputBinding {
  return {
    source: 'gamepad_axis',
    index,
    direction,
    threshold,
  };
}

function axisDiscrete(index: number, axisValue: number, axisTolerance = 0.12): InputBinding {
  return {
    source: 'gamepad_axis',
    index,
    axisValue,
    axisTolerance,
  };
}

function createGamepadPresetBindings(layout: FaceLayout): Partial<Record<N64ControlTarget, InputBinding>> {
  const aFaceIndex = layout === 'nintendo' ? 1 : 0;
  const bFaceIndex = layout === 'nintendo' ? 0 : 1;

  return {
    a: button(aFaceIndex),
    b: button(bFaceIndex),
    z: button(6),
    start: button(9),
    l: button(4),
    r: button(5),
    dpad_up: button(12),
    dpad_down: button(13),
    dpad_left: button(14),
    dpad_right: button(15),
    c_up: axis(3, 'negative', 0.45),
    c_down: axis(3, 'positive', 0.45),
    c_left: axis(2, 'negative', 0.45),
    c_right: axis(2, 'positive', 0.45),
    analog_left: axis(0, 'negative', 0.2),
    analog_right: axis(0, 'positive', 0.2),
    analog_up: axis(1, 'negative', 0.2),
    analog_down: axis(1, 'positive', 0.2),
  };
}

function create8BitDo64PresetBindings(): Partial<Record<N64ControlTarget, InputBinding>> {
  return {
    a: button(0),
    b: button(1),
    z: button(8),
    start: button(11),
    l: button(6),
    r: button(7),
    // 8BitDo 64 exposes D-pad on a hat-style axis (axis 9) with discrete values.
    dpad_up: axisDiscrete(9, -1),
    dpad_down: axisDiscrete(9, 1 / 7),
    dpad_left: axisDiscrete(9, 5 / 7),
    dpad_right: axisDiscrete(9, -3 / 7),
    c_up: axis(5, 'negative', 0.4),
    c_down: axis(5, 'positive', 0.4),
    c_left: axis(2, 'negative', 0.4),
    c_right: axis(2, 'positive', 0.4),
    analog_left: axis(0, 'negative', 0.2),
    analog_right: axis(0, 'positive', 0.2),
    analog_up: axis(1, 'negative', 0.2),
    analog_down: axis(1, 'positive', 0.2),
  };
}

function createBindingsForTemplate(templateId: string): Partial<Record<N64ControlTarget, InputBinding>> {
  if (templateId === PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID) {
    return createGamepadPresetBindings('nintendo');
  }
  if (templateId === PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID) {
    return createGamepadPresetBindings('xbox');
  }
  if (templateId === PRECONFIGURED_BACKBONE_PROFILE_TEMPLATE_ID) {
    return createGamepadPresetBindings('xbox');
  }
  if (templateId === PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID) {
    return create8BitDo64PresetBindings();
  }
  return {};
}

export function createKeyboardDefaultProfile(updatedAt = Date.now()): ControllerProfile {
  return {
    profileId: DEFAULT_KEYBOARD_PROFILE_ID,
    name: 'Keyboard Default',
    deviceId: 'keyboard-default',
    deadzone: 0.2,
    bindings: createKeyboardPresetBindings(),
    updatedAt,
  };
}

export function createPreconfiguredGamepadProfileTemplate(
  templateId: string,
  updatedAt = Date.now(),
): ControllerProfile | undefined {
  const template = PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES.find((entry) => entry.templateId === templateId);
  if (!template) {
    return undefined;
  }

  return {
    profileId: template.templateId,
    name: template.name,
    deviceId: template.deviceId,
    deadzone: template.deadzone,
    bindings: createBindingsForTemplate(template.templateId),
    updatedAt,
  };
}

export function isLegacy8BitDoPreset(profile: ControllerProfile): boolean {
  if (profile.profileId !== PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID) {
    return false;
  }

  const startBinding = profile.bindings.start;
  const dpadUpBinding = profile.bindings.dpad_up;

  return (
    startBinding?.source === 'gamepad_button'
    && startBinding.index === 9
    && dpadUpBinding?.source === 'gamepad_button'
    && dpadUpBinding.index === 12
  );
}
