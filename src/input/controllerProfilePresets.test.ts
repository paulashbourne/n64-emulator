import { describe, expect, test } from 'vitest';

import {
  DEFAULT_KEYBOARD_PROFILE_ID,
  PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
  PRECONFIGURED_BACKBONE_PROFILE_TEMPLATE_ID,
  PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES,
  PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID,
  PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID,
  createKeyboardDefaultProfile,
  createPreconfiguredGamepadProfileTemplate,
} from './controllerProfilePresets';

describe('controller profile presets', () => {
  test('includes gamepad template options', () => {
    const templateIds = PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES.map((template) => template.templateId);
    expect(templateIds).toEqual([
      PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID,
      PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID,
      PRECONFIGURED_BACKBONE_PROFILE_TEMPLATE_ID,
      PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
    ]);
  });

  test('creates keyboard default profile', () => {
    const profile = createKeyboardDefaultProfile(123);

    expect(profile.profileId).toBe(DEFAULT_KEYBOARD_PROFILE_ID);
    expect(profile.name).toBe('Keyboard Default');
    expect(profile.deviceId).toBe('keyboard-default');
    expect(profile.updatedAt).toBe(123);
    expect(profile.bindings.a?.source).toBe('keyboard');
    expect(profile.bindings.a?.code).toBe('KeyX');
  });

  test('creates switch and xbox templates with expected face-button mappings', () => {
    const switchProfile = createPreconfiguredGamepadProfileTemplate(PRECONFIGURED_SWITCH_PROFILE_TEMPLATE_ID, 1);
    const xboxProfile = createPreconfiguredGamepadProfileTemplate(PRECONFIGURED_XBOX_PROFILE_TEMPLATE_ID, 2);

    expect(switchProfile?.bindings.a?.source).toBe('gamepad_button');
    expect(switchProfile?.bindings.a?.index).toBe(1);
    expect(switchProfile?.bindings.b?.index).toBe(0);
    expect(xboxProfile?.bindings.a?.source).toBe('gamepad_button');
    expect(xboxProfile?.bindings.a?.index).toBe(0);
    expect(xboxProfile?.bindings.b?.index).toBe(1);
  });

  test('creates 8BitDo template with hat-axis d-pad defaults', () => {
    const bitdoProfile = createPreconfiguredGamepadProfileTemplate(PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID);

    expect(bitdoProfile?.bindings.z?.source).toBe('gamepad_button');
    expect(bitdoProfile?.bindings.z?.index).toBe(8);
    expect(bitdoProfile?.bindings.start?.index).toBe(11);
    expect(bitdoProfile?.bindings.dpad_up?.source).toBe('gamepad_axis');
    expect(bitdoProfile?.bindings.dpad_up?.index).toBe(9);
    expect(bitdoProfile?.bindings.dpad_up?.axisValue).toBe(-1);
    expect(bitdoProfile?.bindings.dpad_right?.axisValue).toBeCloseTo(-3 / 7, 6);
  });

  test('returns undefined for unknown template ids', () => {
    const unknown = createPreconfiguredGamepadProfileTemplate('profile:unknown');
    expect(unknown).toBeUndefined();
  });
});
