import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from './authStore';

vi.mock('../online/authApi', () => ({
  getCurrentUser: vi.fn(async () => null),
  login: vi.fn(async () => ({
    userId: 'user-1',
    username: 'paul',
    email: 'p@example.com',
    country: 'US',
    avatarUrl: null,
  })),
  signup: vi.fn(async () => ({
    userId: 'user-2',
    username: 'newuser',
    email: 'n@example.com',
    country: 'US',
    avatarUrl: null,
  })),
  logout: vi.fn(async () => undefined),
  updateCurrentUserCountry: vi.fn(),
  uploadCurrentUserAvatar: vi.fn(),
  deleteCurrentUserAvatar: vi.fn(),
}));

vi.mock('../emulator/cloudSaveSync', () => ({
  backfillCloudSavesFromLocal: vi.fn(async () => undefined),
}));

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'loading',
      user: undefined,
      initialized: false,
      authError: undefined,
    });
    vi.clearAllMocks();
  });

  test('bootstraps guest session when no account cookie is present', async () => {
    await useAuthStore.getState().bootstrapAuth();
    const state = useAuthStore.getState();
    expect(state.status).toBe('guest');
    expect(state.user).toBeUndefined();
    expect(state.initialized).toBe(true);
  });

  test('logs in with username/password and stores authenticated user', async () => {
    await useAuthStore.getState().loginWithPassword({
      username: 'paul',
      password: 'secret123',
    });
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.user?.username).toBe('paul');
  });

  test('logs out back to guest state', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        userId: 'user-1',
        username: 'paul',
        email: 'p@example.com',
        country: 'US',
        avatarUrl: null,
      },
      initialized: true,
      authError: undefined,
    });

    await useAuthStore.getState().logoutUser();
    const state = useAuthStore.getState();
    expect(state.status).toBe('guest');
    expect(state.user).toBeUndefined();
  });
});
