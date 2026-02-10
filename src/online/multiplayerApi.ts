import type {
  CreateSessionResponse,
  GetSessionResponse,
  JoinSessionResponse,
} from '../types/multiplayer';

function sanitizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
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
  romId?: string;
  romTitle?: string;
}): Promise<CreateSessionResponse> {
  const response = await fetch('/api/multiplayer/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      hostName: input.hostName,
      romId: input.romId,
      romTitle: input.romTitle,
    }),
  });

  return parseJsonOrThrow<CreateSessionResponse>(response);
}

export async function joinOnlineSession(input: {
  code: string;
  name: string;
}): Promise<JoinSessionResponse> {
  const code = sanitizeInviteCode(input.code);
  const response = await fetch(`/api/multiplayer/sessions/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
    }),
  });

  return parseJsonOrThrow<JoinSessionResponse>(response);
}

export async function getOnlineSession(code: string): Promise<GetSessionResponse> {
  const normalized = sanitizeInviteCode(code);
  const response = await fetch(`/api/multiplayer/sessions/${encodeURIComponent(normalized)}`);
  return parseJsonOrThrow<GetSessionResponse>(response);
}

export function multiplayerSocketUrl(code: string, clientId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}/ws/multiplayer`);
  url.searchParams.set('code', sanitizeInviteCode(code));
  url.searchParams.set('clientId', clientId);
  return url.toString();
}
