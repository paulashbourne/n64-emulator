import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getCurrentUserPreferences, putCurrentUserPreferences } from '../online/authApi';
import { usePreferencesStore } from './preferencesStore';
import type { UserUiPreferences } from '../types/ux';

vi.mock('../online/authApi', () => ({
  getCurrentUserPreferences: vi.fn(),
  putCurrentUserPreferences: vi.fn(),
}));

const UX_PREFERENCES_STORAGE_KEY = 'ux_user_preferences_v1';

function baselinePreferences(): UserUiPreferences {
  return {
    onboarding: {
      steps: {
        import_rom: false,
        launch_game: false,
        verify_controls: false,
        online_session: false,
      },
      updatedAt: 100,
    },
    online: {},
    play: {},
    profile: {},
    updatedAt: 100,
  };
}

describe('preferencesStore', () => {
  beforeEach(() => {
    window.localStorage.removeItem(UX_PREFERENCES_STORAGE_KEY);
    usePreferencesStore.setState({
      initialized: false,
      authenticated: false,
      syncing: false,
      preferences: baselinePreferences(),
    });
    vi.clearAllMocks();
  });

  test('hydrates local preferences from storage', () => {
    const stored: UserUiPreferences = {
      ...baselinePreferences(),
      play: { autoHideHudWhileRunning: false },
      updatedAt: 250,
    };
    window.localStorage.setItem(UX_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));

    usePreferencesStore.getState().hydrateLocal();

    const state = usePreferencesStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.preferences.play.autoHideHudWhileRunning).toBe(false);
    expect(state.preferences.updatedAt).toBe(250);
  });

  test('pulls newer remote preferences and skips push when remote wins', async () => {
    const remote: UserUiPreferences = {
      ...baselinePreferences(),
      online: { guestFocusMode: true },
      updatedAt: 900,
    };
    vi.mocked(getCurrentUserPreferences).mockResolvedValue({
      preferences: remote,
      updatedAt: remote.updatedAt,
    });

    usePreferencesStore.setState({
      authenticated: true,
      preferences: {
        ...baselinePreferences(),
        updatedAt: 200,
      },
    });

    await usePreferencesStore.getState().pullFromCloud();

    const state = usePreferencesStore.getState();
    expect(state.preferences.updatedAt).toBe(900);
    expect(state.preferences.online.guestFocusMode).toBe(true);
    expect(putCurrentUserPreferences).not.toHaveBeenCalled();
  });

  test('keeps newer local preferences and pushes them during pull', async () => {
    const local: UserUiPreferences = {
      ...baselinePreferences(),
      play: { autoHideHudWhileRunning: false },
      updatedAt: 1_500,
    };
    const remote: UserUiPreferences = {
      ...baselinePreferences(),
      play: { autoHideHudWhileRunning: true },
      updatedAt: 400,
    };
    vi.mocked(getCurrentUserPreferences).mockResolvedValue({
      preferences: remote,
      updatedAt: remote.updatedAt,
    });
    vi.mocked(putCurrentUserPreferences).mockResolvedValue({
      preferences: local,
      updatedAt: local.updatedAt,
    });

    usePreferencesStore.setState({
      authenticated: true,
      preferences: local,
    });

    await usePreferencesStore.getState().pullFromCloud();

    expect(putCurrentUserPreferences).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putCurrentUserPreferences).mock.calls[0]?.[0]).toMatchObject({
      updatedAt: 1_500,
      play: { autoHideHudWhileRunning: false },
    });
    expect(usePreferencesStore.getState().preferences.updatedAt).toBe(1_500);
  });

  test('updates play preferences locally and pushes when authenticated', async () => {
    vi.mocked(putCurrentUserPreferences).mockImplementation(async (preferences: UserUiPreferences) => ({
      preferences,
      updatedAt: preferences.updatedAt,
    }));

    usePreferencesStore.setState({
      authenticated: true,
      preferences: baselinePreferences(),
    });

    await usePreferencesStore.getState().updatePlayPreferences({
      autoHideHudWhileRunning: false,
      activeMenuTab: 'saves',
    });

    const state = usePreferencesStore.getState();
    expect(state.preferences.play.autoHideHudWhileRunning).toBe(false);
    expect(state.preferences.play.activeMenuTab).toBe('saves');
    expect(putCurrentUserPreferences).toHaveBeenCalledTimes(1);
  });
});
