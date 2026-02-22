import { create } from 'zustand';

import { getCurrentUserPreferences, putCurrentUserPreferences } from '../online/authApi';
import type { OnboardingProgress, UserUiPreferences } from '../types/ux';

const UX_PREFERENCES_STORAGE_KEY = 'ux_user_preferences_v1';

function defaultOnboardingProgress(): OnboardingProgress {
  return {
    steps: {
      import_rom: false,
      launch_game: false,
      verify_controls: false,
      online_session: false,
    },
    updatedAt: Date.now(),
  };
}

function defaultPreferences(): UserUiPreferences {
  const onboarding = defaultOnboardingProgress();
  const now = Date.now();
  return {
    onboarding,
    online: {},
    play: {},
    profile: {},
    updatedAt: Math.max(onboarding.updatedAt, now),
  };
}

function readStoredPreferences(): UserUiPreferences {
  if (typeof window === 'undefined') {
    return defaultPreferences();
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(UX_PREFERENCES_STORAGE_KEY);
  } catch {
    return defaultPreferences();
  }

  if (!raw) {
    return defaultPreferences();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UserUiPreferences>;
    const defaults = defaultPreferences();
    return {
      onboarding: {
        steps: {
          import_rom: parsed.onboarding?.steps?.import_rom === true,
          launch_game: parsed.onboarding?.steps?.launch_game === true,
          verify_controls: parsed.onboarding?.steps?.verify_controls === true,
          online_session: parsed.onboarding?.steps?.online_session === true,
        },
        dismissedAt:
          typeof parsed.onboarding?.dismissedAt === 'number'
            ? Math.max(0, Math.round(parsed.onboarding.dismissedAt))
            : undefined,
        updatedAt:
          typeof parsed.onboarding?.updatedAt === 'number'
            ? Math.max(0, Math.round(parsed.onboarding.updatedAt))
            : defaults.onboarding.updatedAt,
      },
      online: {
        guestFocusMode:
          typeof parsed.online?.guestFocusMode === 'boolean' ? parsed.online.guestFocusMode : undefined,
        showVirtualController:
          typeof parsed.online?.showVirtualController === 'boolean' ? parsed.online.showVirtualController : undefined,
        guestInputRelayMode:
          parsed.online?.guestInputRelayMode === 'auto'
          || parsed.online?.guestInputRelayMode === 'responsive'
          || parsed.online?.guestInputRelayMode === 'balanced'
          || parsed.online?.guestInputRelayMode === 'conservative'
            ? parsed.online.guestInputRelayMode
            : undefined,
        hostControlsCollapsed:
          typeof parsed.online?.hostControlsCollapsed === 'boolean' ? parsed.online.hostControlsCollapsed : undefined,
        hostChatCollapsed:
          typeof parsed.online?.hostChatCollapsed === 'boolean' ? parsed.online.hostChatCollapsed : undefined,
      },
      play: {
        autoHideHudWhileRunning:
          typeof parsed.play?.autoHideHudWhileRunning === 'boolean' ? parsed.play.autoHideHudWhileRunning : undefined,
        activeMenuTab:
          parsed.play?.activeMenuTab === 'gameplay'
          || parsed.play?.activeMenuTab === 'saves'
          || parsed.play?.activeMenuTab === 'controls'
          || parsed.play?.activeMenuTab === 'online'
            ? parsed.play.activeMenuTab
            : undefined,
        showOnlineAdvancedTools:
          typeof parsed.play?.showOnlineAdvancedTools === 'boolean' ? parsed.play.showOnlineAdvancedTools : undefined,
      },
      profile: {
        displayName: typeof parsed.profile?.displayName === 'string' ? parsed.profile.displayName : undefined,
        avatarUrl: typeof parsed.profile?.avatarUrl === 'string' ? parsed.profile.avatarUrl : undefined,
        country: typeof parsed.profile?.country === 'string' ? parsed.profile.country : undefined,
      },
      updatedAt:
        typeof parsed.updatedAt === 'number'
          ? Math.max(0, Math.round(parsed.updatedAt))
          : defaults.updatedAt,
    };
  } catch {
    return defaultPreferences();
  }
}

function persistPreferences(preferences: UserUiPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(UX_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore persistence failures.
  }
}

function mergeByLastWrite(local: UserUiPreferences, remote: UserUiPreferences): UserUiPreferences {
  return remote.updatedAt > local.updatedAt ? remote : local;
}

async function syncOnboardingStore(progress: OnboardingProgress): Promise<void> {
  try {
    const module = await import('./onboardingStore');
    module.applyOnboardingProgress(progress);
  } catch {
    // Onboarding store sync is best-effort.
  }
}

interface PreferencesStoreState {
  initialized: boolean;
  authenticated: boolean;
  syncing: boolean;
  preferences: UserUiPreferences;
  hydrateLocal: () => void;
  setAuthenticated: (authenticated: boolean) => void;
  pullFromCloud: () => Promise<void>;
  pushToCloud: () => Promise<void>;
  syncFromOnboarding: (progress: OnboardingProgress) => Promise<void>;
  updatePlayPreferences: (patch: Partial<UserUiPreferences['play']>) => Promise<void>;
  updateOnlinePreferences: (patch: Partial<UserUiPreferences['online']>) => Promise<void>;
  updateProfilePreferences: (patch: Partial<UserUiPreferences['profile']>) => Promise<void>;
}

export const usePreferencesStore = create<PreferencesStoreState>((set, get) => ({
  initialized: false,
  authenticated: false,
  syncing: false,
  preferences: defaultPreferences(),

  hydrateLocal: () => {
    const preferences = readStoredPreferences();
    set({ preferences, initialized: true });
    void syncOnboardingStore(preferences.onboarding);
  },

  setAuthenticated: (authenticated) => {
    set({ authenticated });
  },

  pullFromCloud: async () => {
    const { authenticated } = get();
    if (!authenticated) {
      return;
    }

    set({ syncing: true });
    try {
      const local = get().preferences;
      const remotePayload = await getCurrentUserPreferences();
      const merged = mergeByLastWrite(local, remotePayload.preferences);
      persistPreferences(merged);
      set({ preferences: merged });
      void syncOnboardingStore(merged.onboarding);
      if (merged.updatedAt === local.updatedAt) {
        await putCurrentUserPreferences(merged);
      }
    } finally {
      set({ syncing: false });
    }
  },

  pushToCloud: async () => {
    const { authenticated, preferences } = get();
    if (!authenticated) {
      return;
    }

    set({ syncing: true });
    try {
      const remote = await putCurrentUserPreferences(preferences);
      const merged = mergeByLastWrite(preferences, remote.preferences);
      persistPreferences(merged);
      set({ preferences: merged });
      void syncOnboardingStore(merged.onboarding);
    } finally {
      set({ syncing: false });
    }
  },

  syncFromOnboarding: async (progress) => {
    const current = get().preferences;
    const next: UserUiPreferences = {
      ...current,
      onboarding: {
        ...progress,
      },
      updatedAt: Math.max(Date.now(), progress.updatedAt, current.updatedAt + 1),
    };
    persistPreferences(next);
    set({ preferences: next });
    if (get().authenticated) {
      await get().pushToCloud();
    }
  },

  updatePlayPreferences: async (patch) => {
    const current = get().preferences;
    const next: UserUiPreferences = {
      ...current,
      play: {
        ...current.play,
        ...patch,
      },
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    persistPreferences(next);
    set({ preferences: next });
    if (get().authenticated) {
      await get().pushToCloud();
    }
  },

  updateOnlinePreferences: async (patch) => {
    const current = get().preferences;
    const next: UserUiPreferences = {
      ...current,
      online: {
        ...current.online,
        ...patch,
      },
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    persistPreferences(next);
    set({ preferences: next });
    if (get().authenticated) {
      await get().pushToCloud();
    }
  },

  updateProfilePreferences: async (patch) => {
    const current = get().preferences;
    const next: UserUiPreferences = {
      ...current,
      profile: {
        ...current.profile,
        ...patch,
      },
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    persistPreferences(next);
    set({ preferences: next });
    if (get().authenticated) {
      await get().pushToCloud();
    }
  },
}));
