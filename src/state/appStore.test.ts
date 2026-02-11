import { db } from '../storage/db';
import { useAppStore } from './appStore';

const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';

describe('app store profile defaults', () => {
  beforeEach(async () => {
    await db.profiles.clear();
    useAppStore.setState({
      profiles: [],
      activeProfileId: undefined,
    });
  });

  test('seeds default keyboard profile when loading profiles', async () => {
    await useAppStore.getState().loadProfiles();

    const profiles = useAppStore.getState().profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profileId).toBe(DEFAULT_KEYBOARD_PROFILE_ID);
    expect(profiles[0].name).toBe('Keyboard Default');
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

  test('default keyboard profile is not duplicated across loads', async () => {
    await useAppStore.getState().loadProfiles();
    await useAppStore.getState().loadProfiles();

    const allProfiles = await db.profiles.toArray();
    const defaults = allProfiles.filter((profile) => profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID);
    expect(defaults).toHaveLength(1);
  });
});
