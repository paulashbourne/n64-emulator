import { create } from 'zustand';

import { backfillCloudSavesFromLocal } from '../emulator/cloudSaveSync';
import {
  deleteCurrentUserAvatar,
  getCurrentUser,
  login,
  logout,
  signup,
  updateCurrentUserCountry,
  uploadCurrentUserAvatar,
} from '../online/authApi';
import type { AuthenticatedUser, AuthStatus } from '../types/auth';

interface AuthStoreState {
  status: AuthStatus;
  user?: AuthenticatedUser;
  initialized: boolean;
  authError?: string;
  bootstrapAuth: () => Promise<void>;
  signupWithPassword: (input: { email: string; username: string; password: string }) => Promise<void>;
  loginWithPassword: (input: { username: string; password: string }) => Promise<void>;
  logoutUser: () => Promise<void>;
  setCountry: (country: string) => Promise<void>;
  uploadAvatar: (dataUrl: string) => Promise<void>;
  clearAvatar: () => Promise<void>;
  clearAuthError: () => void;
}

let bootstrapPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthStoreState>((set) => ({
  status: 'loading',
  user: undefined,
  initialized: false,
  authError: undefined,

  bootstrapAuth: async () => {
    if (bootstrapPromise) {
      return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
      try {
        const user = await getCurrentUser();
        if (user) {
          set({
            status: 'authenticated',
            user,
            initialized: true,
            authError: undefined,
          });
          void backfillCloudSavesFromLocal(true).catch((error) => {
            const message = error instanceof Error ? error.message : 'Cloud save backfill failed.';
            console.warn(`Cloud backfill unavailable: ${message}`);
          });
          return;
        }
        set({
          status: 'guest',
          user: undefined,
          initialized: true,
          authError: undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not verify account session.';
        set({
          status: 'guest',
          user: undefined,
          initialized: true,
          authError: message,
        });
      }
    })().finally(() => {
      bootstrapPromise = null;
    });

    return bootstrapPromise;
  },

  signupWithPassword: async ({ email, username, password }) => {
    set({ authError: undefined });
    const user = await signup({ email, username, password });
    set({
      status: 'authenticated',
      user,
      initialized: true,
      authError: undefined,
    });
    void backfillCloudSavesFromLocal(true).catch((error) => {
      const message = error instanceof Error ? error.message : 'Cloud save backfill failed.';
      console.warn(`Cloud backfill unavailable: ${message}`);
    });
  },

  loginWithPassword: async ({ username, password }) => {
    set({ authError: undefined });
    const user = await login({ username, password });
    set({
      status: 'authenticated',
      user,
      initialized: true,
      authError: undefined,
    });
    void backfillCloudSavesFromLocal(true).catch((error) => {
      const message = error instanceof Error ? error.message : 'Cloud save backfill failed.';
      console.warn(`Cloud backfill unavailable: ${message}`);
    });
  },

  logoutUser: async () => {
    try {
      await logout();
    } finally {
      set({
        status: 'guest',
        user: undefined,
        initialized: true,
        authError: undefined,
      });
    }
  },

  setCountry: async (country: string) => {
    const user = await updateCurrentUserCountry(country);
    set({
      status: 'authenticated',
      user,
      authError: undefined,
    });
  },

  uploadAvatar: async (dataUrl: string) => {
    const user = await uploadCurrentUserAvatar(dataUrl);
    set({
      status: 'authenticated',
      user,
      authError: undefined,
    });
  },

  clearAvatar: async () => {
    const user = await deleteCurrentUserAvatar();
    set({
      status: 'authenticated',
      user,
      authError: undefined,
    });
  },

  clearAuthError: () => {
    set({ authError: undefined });
  },
}));
