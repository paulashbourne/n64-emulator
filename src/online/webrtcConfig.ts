const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ['stun:stun.l.google.com:19302'],
  },
];

function sanitizeIceServer(server: unknown): RTCIceServer | null {
  if (!server || typeof server !== 'object') {
    return null;
  }

  const candidate = server as {
    urls?: unknown;
    username?: unknown;
    credential?: unknown;
  };

  const urlsInput = candidate.urls;
  const urls =
    typeof urlsInput === 'string'
      ? urlsInput.trim()
      : Array.isArray(urlsInput)
        ? urlsInput
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim())
        : null;
  if (!urls || (Array.isArray(urls) && urls.length === 0)) {
    return null;
  }

  const result: RTCIceServer = {
    urls,
  };

  if (typeof candidate.username === 'string' && candidate.username.trim().length > 0) {
    result.username = candidate.username.trim();
  }
  if (typeof candidate.credential === 'string' && candidate.credential.trim().length > 0) {
    result.credential = candidate.credential.trim();
  }
  return result;
}

function parseIceServersFromEnv(rawValue: string | undefined): RTCIceServer[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const servers = entries.map(sanitizeIceServer).filter((entry): entry is RTCIceServer => entry !== null);
    if (servers.length > 0) {
      return servers;
    }
  } catch {
    // Fall back to defaults if parsing fails.
  }

  return undefined;
}

export const WEBRTC_CONFIGURATION: RTCConfiguration = {
  iceServers: parseIceServersFromEnv(import.meta.env.VITE_MULTIPLAYER_ICE_SERVERS as string | undefined) ??
    DEFAULT_ICE_SERVERS,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 2,
};
