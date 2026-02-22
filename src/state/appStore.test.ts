import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_KEYBOARD_PROFILE_ID,
  PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
  PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES,
} from '../input/controllerProfilePresets';
import { db } from '../storage/db';
import { useAppStore } from './appStore';

const PRECONFIGURED_GAMEPAD_TEMPLATE_IDS = PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES.map((template) => template.templateId);

describe('app store profile defaults', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          return new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }

        return new Response(JSON.stringify({ profiles: [] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }),
    );

    await db.profiles.clear();
    useAppStore.setState({
      profiles: [],
      activeProfileId: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('seeds only keyboard default profile when loading profiles', async () => {
    await useAppStore.getState().loadProfiles();

    const profiles = useAppStore.getState().profiles;
    const profileIds = profiles.map((profile) => profile.profileId);
    expect(profiles).toHaveLength(1);
    expect(profileIds).toContain(DEFAULT_KEYBOARD_PROFILE_ID);
    expect(useAppStore.getState().activeProfileId).toBe(DEFAULT_KEYBOARD_PROFILE_ID);
  });

  test('default keyboard profile is included for rom-specific loads', async () => {
    await db.profiles.put({
      profileId: 'profile:rom-only',
      name: 'ROM Profile',
      deviceId: 'keyboard-generic',
      romHash: 'rom-123',
      deadzone: 0.2,
      bindings: {},
      updatedAt: Date.now() + 1,
    });

    await useAppStore.getState().loadProfiles('rom-123');
    const profileIds = useAppStore.getState().profiles.map((profile) => profile.profileId);
    expect(profileIds).toContain(DEFAULT_KEYBOARD_PROFILE_ID);
    expect(profileIds).toContain('profile:rom-only');
  });

  test('does not auto-seed preconfigured gamepad templates when loading profiles', async () => {
    await useAppStore.getState().loadProfiles();
    const profileIds = useAppStore.getState().profiles.map((profile) => profile.profileId);

    for (const templateId of PRECONFIGURED_GAMEPAD_TEMPLATE_IDS) {
      expect(profileIds).not.toContain(templateId);
    }
  });

  test('default keyboard profile is not duplicated across loads', async () => {
    await useAppStore.getState().loadProfiles();
    await useAppStore.getState().loadProfiles();

    const allProfiles = await db.profiles.toArray();
    const defaults = allProfiles.filter((profile) => profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID);
    expect(defaults).toHaveLength(1);
  });

  test('upgrades legacy 8BitDo default profile mapping to hat-axis d-pad defaults', async () => {
    await db.profiles.put({
      profileId: PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
      name: '8BitDo 64 Bluetooth Controller',
      deviceId: 'preset-8bitdo-64-controller',
      deadzone: 0.2,
      bindings: {
        a: { source: 'gamepad_button', index: 1 },
        b: { source: 'gamepad_button', index: 0 },
        z: { source: 'gamepad_button', index: 6 },
        start: { source: 'gamepad_button', index: 9 },
        l: { source: 'gamepad_button', index: 4 },
        r: { source: 'gamepad_button', index: 5 },
        dpad_up: { source: 'gamepad_button', index: 12 },
        dpad_down: { source: 'gamepad_button', index: 13 },
        dpad_left: { source: 'gamepad_button', index: 14 },
        dpad_right: { source: 'gamepad_button', index: 15 },
      },
      updatedAt: Date.now() - 1_000,
    });

    await useAppStore.getState().loadProfiles();
    const upgraded = useAppStore
      .getState()
      .profiles.find((profile) => profile.profileId === PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID);

    expect(upgraded?.bindings.start?.index).toBe(11);
    expect(upgraded?.bindings.z?.index).toBe(8);
    expect(upgraded?.bindings.dpad_up?.source).toBe('gamepad_axis');
    expect(upgraded?.bindings.dpad_up?.index).toBe(9);
    expect(upgraded?.bindings.dpad_up?.axisValue).toBe(-1);
    expect(upgraded?.bindings.dpad_right?.axisValue).toBeCloseTo(-3 / 7, 6);
  });

  test('saved profiles are normalized to global scope', async () => {
    await useAppStore.getState().saveProfile({
      profileId: 'profile:scoped-test',
      name: 'Scoped Test',
      deviceId: 'test-device',
      romHash: 'rom-123',
      deadzone: 0.2,
      bindings: {},
      updatedAt: Date.now(),
    });

    const stored = await db.profiles.get('profile:scoped-test');
    expect(stored).toBeDefined();
    expect(stored?.romHash).toBeUndefined();
  });

  test('keeps controller profiles local-only when loading profiles', async () => {
    await db.profiles.put({
      profileId: 'profile:local-only',
      name: 'Local Only',
      deviceId: 'test-device',
      deadzone: 0.2,
      bindings: {
        a: { source: 'gamepad_button', index: 0 },
      },
      updatedAt: 100,
    });

    await useAppStore.getState().loadProfiles();
    const local = await db.profiles.get('profile:local-only');
    expect(local).toBeDefined();
    expect(local?.name).toBe('Local Only');
    expect(local?.bindings.a?.index).toBe(0);
  });
});
