import type {
  CloseSessionResponse,
  CreateSessionResponse,
  GetSessionResponse,
  KickMemberResponse,
  JoinSessionResponse,
} from '../types/multiplayer';

const REQUEST_TIMEOUT_MS = 10_000;

function sanitizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

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
    // Keep realtime flows direct in local dev (including LAN device testing) and avoid proxy overhead.
    return `${protocol}//${window.location.hostname}:${multiplayerCoordinatorDevPort()}`;
  }

  return window.location.origin;
}

function multiplayerApiUrl(pathname: string): string {
  return new URL(pathname, multiplayerHttpBaseOrigin()).toString();
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
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

export async function createOnlineSession(input: {
  hostName: string;
  avatarUrl?: string;
  romId?: string;
  romTitle?: string;
}): Promise<CreateSessionResponse> {
  const response = await fetchWithTimeout(
    multiplayerApiUrl('/api/multiplayer/sessions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostName: input.hostName,
        avatarUrl: input.avatarUrl,
        romId: input.romId,
        romTitle: input.romTitle,
      }),
    },
  );

  return parseJsonOrThrow<CreateSessionResponse>(response);
}

export async function joinOnlineSession(input: {
  code: string;
  name: string;
  avatarUrl?: string;
}): Promise<JoinSessionResponse> {
  const code = sanitizeInviteCode(input.code);
  const response = await fetchWithTimeout(
    multiplayerApiUrl(`/api/multiplayer/sessions/${encodeURIComponent(code)}/join`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        avatarUrl: input.avatarUrl,
      }),
    },
  );

  return parseJsonOrThrow<JoinSessionResponse>(response);
}

export async function getOnlineSession(code: string): Promise<GetSessionResponse> {
  const normalized = sanitizeInviteCode(code);
  const response = await fetchWithTimeout(multiplayerApiUrl(`/api/multiplayer/sessions/${encodeURIComponent(normalized)}`), {
    method: 'GET',
  });
  return parseJsonOrThrow<GetSessionResponse>(response);
}

export async function closeOnlineSession(input: {
  code: string;
  clientId: string;
}): Promise<CloseSessionResponse> {
  const normalized = sanitizeInviteCode(input.code);
  const response = await fetchWithTimeout(
    multiplayerApiUrl(`/api/multiplayer/sessions/${encodeURIComponent(normalized)}/close`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: input.clientId,
      }),
    },
  );

  return parseJsonOrThrow<CloseSessionResponse>(response);
}

export async function kickOnlineMember(input: {
  code: string;
  clientId: string;
  targetClientId: string;
}): Promise<KickMemberResponse> {
  const normalized = sanitizeInviteCode(input.code);
  const response = await fetchWithTimeout(
    multiplayerApiUrl(`/api/multiplayer/sessions/${encodeURIComponent(normalized)}/kick`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: input.clientId,
        targetClientId: input.targetClientId,
      }),
    },
  );

  return parseJsonOrThrow<KickMemberResponse>(response);
}

function multiplayerWsBaseOrigin(): string {
  const configuredOrigin = (import.meta.env.VITE_MULTIPLAYER_WS_ORIGIN as string | undefined)?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/+$/, '');
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) {
    // Skip the Vite WS proxy in local development for lower latency and less churn.
    return `${wsProtocol}//${window.location.hostname}:${multiplayerCoordinatorDevPort()}`;
  }

  return `${wsProtocol}//${window.location.host}`;
}

export function multiplayerSocketUrl(code: string, clientId: string): string {
  const url = new URL('/ws/multiplayer', multiplayerWsBaseOrigin());
  url.searchParams.set('code', sanitizeInviteCode(code));
  url.searchParams.set('clientId', clientId);
  return url.toString();
}
