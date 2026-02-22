import type { AuthenticatedUser, CloudSaveMetadata, CloudSaveRecord } from '../types/auth';

const REQUEST_TIMEOUT_MS = 12_000;

function multiplayerCoordinatorDevPort(): string {
  const configuredPort = (import.meta.env.VITE_MULTIPLAYER_COORDINATOR_PORT as string | undefined)?.trim();
  return configuredPort && /^[0-9]{2,5}$/.test(configuredPort) ? configuredPort : '8787';
}

function multiplayerHttpBaseOrigin(): string {
  const configuredOrigin = (import.meta.env.VITE_MULTIPLAYER_HTTP_ORIGIN as string | undefined)?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/+$/, '');
  }

  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:${multiplayerCoordinatorDevPort()}`;
  }

  return window.location.origin;
}

function authApiUrl(pathname: string): string {
  return new URL(pathname, multiplayerHttpBaseOrigin()).toString();
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  return payload;
}

type AuthPayload = {
  user: AuthenticatedUser;
};

export async function signup(input: {
  email: string;
  username: string;
  password: string;
}): Promise<AuthenticatedUser> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/signup'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await parseJsonOrThrow<AuthPayload>(response);
  return payload.user;
}

export async function login(input: {
  username: string;
  password: string;
}): Promise<AuthenticatedUser> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await parseJsonOrThrow<AuthPayload>(response);
  return payload.user;
}

export async function logout(): Promise<void> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/logout'), {
    method: 'POST',
  });
  await parseJsonOrThrow<{ loggedOut: true }>(response);
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/me'), {
    method: 'GET',
  });
  const payload = await parseJsonOrThrow<{
    authenticated: boolean;
    user?: AuthenticatedUser;
  }>(response);
  if (!payload.authenticated || !payload.user) {
    return null;
  }
  return payload.user;
}

export async function updateCurrentUserCountry(country: string): Promise<AuthenticatedUser> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/me'), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      country,
    }),
  });
  const payload = await parseJsonOrThrow<AuthPayload>(response);
  return payload.user;
}

export async function uploadCurrentUserAvatar(dataUrl: string): Promise<AuthenticatedUser> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/me/avatar'), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dataUrl,
    }),
  });
  const payload = await parseJsonOrThrow<AuthPayload>(response);
  return payload.user;
}

export async function deleteCurrentUserAvatar(): Promise<AuthenticatedUser> {
  const response = await fetchWithTimeout(authApiUrl('/api/auth/me/avatar'), {
    method: 'DELETE',
  });
  const payload = await parseJsonOrThrow<AuthPayload>(response);
  return payload.user;
}

export async function listCloudSaves(): Promise<CloudSaveMetadata[]> {
  const response = await fetchWithTimeout(authApiUrl('/api/cloud-saves'), {
    method: 'GET',
  });
  const payload = await parseJsonOrThrow<{
    saves: CloudSaveMetadata[];
  }>(response);
  return Array.isArray(payload.saves) ? payload.saves : [];
}

export async function getCloudSave(romHash: string, slotId: string): Promise<CloudSaveRecord | null> {
  const response = await fetchWithTimeout(
    authApiUrl(`/api/cloud-saves/${encodeURIComponent(romHash)}/${encodeURIComponent(slotId)}`),
    {
      method: 'GET',
    },
  );
  if (response.status === 404) {
    return null;
  }
  const payload = await parseJsonOrThrow<{
    save?: CloudSaveRecord;
  }>(response);
  return payload.save ?? null;
}

export async function upsertCloudSaves(saves: CloudSaveRecord[]): Promise<CloudSaveMetadata[]> {
  const response = await fetchWithTimeout(authApiUrl('/api/cloud-saves'), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      saves,
    }),
  });
  const payload = await parseJsonOrThrow<{
    saves: CloudSaveMetadata[];
  }>(response);
  return Array.isArray(payload.saves) ? payload.saves : [];
}

export async function deleteCloudSave(romHash: string, slotId: string): Promise<boolean> {
  const response = await fetchWithTimeout(
    authApiUrl(`/api/cloud-saves/${encodeURIComponent(romHash)}/${encodeURIComponent(slotId)}`),
    {
      method: 'DELETE',
    },
  );
  const payload = await parseJsonOrThrow<{
    deleted: boolean;
  }>(response);
  return payload.deleted;
}
