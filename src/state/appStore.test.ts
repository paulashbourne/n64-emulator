import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { db } from '../storage/db';
import { useAppStore } from './appStore';

const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';
const BUILT_IN_PROFILE_IDS = [
  DEFAULT_KEYBOARD_PROFILE_ID,
  'profile:gamepad-switch',
  'profile:gamepad-xbox-series',
  'profile:gamepad-backbone',
  'profile:gamepad-8bitdo-64',
];

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

  test('seeds built-in controller profiles when loading profiles', async () => {
    await useAppStore.getState().loadProfiles();

    const profiles = useAppStore.getState().profiles;
    const profileIds = profiles.map((profile) => profile.profileId);
    expect(profiles).toHaveLength(BUILT_IN_PROFILE_IDS.length);
    for (const builtInId of BUILT_IN_PROFILE_IDS) {
      expect(profileIds).toContain(builtInId);
    }
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

  test('seeds controller-specific face-button mappings for switch and xbox presets', async () => {
    await useAppStore.getState().loadProfiles();
    const profiles = useAppStore.getState().profiles;

    const switchProfile = profiles.find((profile) => profile.profileId === 'profile:gamepad-switch');
    const xboxProfile = profiles.find((profile) => profile.profileId === 'profile:gamepad-xbox-series');
    const bitdoProfile = profiles.find((profile) => profile.profileId === 'profile:gamepad-8bitdo-64');

    expect(switchProfile?.bindings.a?.source).toBe('gamepad_button');
    expect(switchProfile?.bindings.a?.index).toBe(1);
    expect(switchProfile?.bindings.b?.index).toBe(0);
    expect(switchProfile?.bindings.c_up?.source).toBe('gamepad_axis');
    expect(switchProfile?.bindings.c_up?.index).toBe(3);

    expect(xboxProfile?.bindings.a?.source).toBe('gamepad_button');
    expect(xboxProfile?.bindings.a?.index).toBe(0);
    expect(xboxProfile?.bindings.b?.index).toBe(1);

    expect(bitdoProfile?.bindings.z?.source).toBe('gamepad_button');
    expect(bitdoProfile?.bindings.z?.index).toBe(8);
    expect(bitdoProfile?.bindings.start?.index).toBe(11);
    expect(bitdoProfile?.bindings.dpad_up?.source).toBe('gamepad_axis');
    expect(bitdoProfile?.bindings.dpad_up?.index).toBe(9);
    expect(bitdoProfile?.bindings.dpad_up?.axisValue).toBe(-1);
    expect(bitdoProfile?.bindings.dpad_right?.axisValue).toBeCloseTo(-3 / 7, 6);
  });

  test('built-in profiles are not duplicated across loads', async () => {
    await useAppStore.getState().loadProfiles();
    await useAppStore.getState().loadProfiles();

    const allProfiles = await db.profiles.toArray();
    for (const builtInId of BUILT_IN_PROFILE_IDS) {
      const defaults = allProfiles.filter((profile) => profile.profileId === builtInId);
      expect(defaults).toHaveLength(1);
    }
  });

  test('upgrades legacy 8BitDo default profile mapping to hat-axis d-pad defaults', async () => {
    await db.profiles.put({
      profileId: 'profile:gamepad-8bitdo-64',
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
    const upgraded = useAppStore.getState().profiles.find((profile) => profile.profileId === 'profile:gamepad-8bitdo-64');

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
