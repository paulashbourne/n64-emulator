import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { createOnlineSession, getOnlineSession, joinOnlineSession } from '../online/multiplayerApi';
import { buildInviteJoinUrl } from '../online/sessionLinks';
import {
  clearRecentOnlineSessions,
  getOnlineIdentityProfile,
  getRecentOnlineSessions,
  removeRecentOnlineSession,
  rememberOnlineSession,
  setOnlineIdentityProfile,
  type RecentOnlineSession,
} from '../storage/appSettings';
import { useAppStore } from '../state/appStore';
import { useAuthStore } from '../state/authStore';

const NO_ROM_SELECTED = '__none__';

function normalizePlayerName(name: string, fallback: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim().slice(0, 32);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function extractInviteCodeInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsedUrl = new URL(trimmed);
    const queryCode = parsedUrl.searchParams.get('code');
    if (queryCode) {
      return normalizeInviteCode(queryCode);
    }
    const sessionPathMatch = parsedUrl.pathname.match(/\/online\/session\/([A-Z0-9]{6})/i);
    if (sessionPathMatch?.[1]) {
      return normalizeInviteCode(sessionPathMatch[1]);
    }
  } catch {
    // Input might be a raw invite code rather than a URL.
  }

  const codeMatch = trimmed.toUpperCase().match(/[A-Z0-9]{6}/);
  return normalizeInviteCode(codeMatch?.[0] ?? trimmed);
}

function normalizeAvatarUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().slice(0, 500);
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('data:image/')
    || normalized.startsWith('/api/avatars/')
  ) {
    return normalized;
  }
  return undefined;
}

function initialsFromName(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return 'P';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
}

function OnlineAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = normalizeAvatarUrl(avatarUrl);
  const showImage = Boolean(src && failedUrl !== src);

  return (
    <div className={`online-avatar ${className ?? ''}`.trim()} aria-hidden="true">
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(src ?? null)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span>{initialsFromName(name)}</span>
      )}
    </div>
  );
}

export function OnlinePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const roms = useAppStore((state) => state.roms);
  const refreshRoms = useAppStore((state) => state.refreshRoms);
  const authStatus = useAuthStore((state) => state.status);
  const authUser = useAuthStore((state) => state.user);
  const uploadAccountAvatar = useAuthStore((state) => state.uploadAvatar);
  const clearAccountAvatar = useAuthStore((state) => state.clearAvatar);

  const [hostName, setHostName] = useState('Player 1');
  const [joinName, setJoinName] = useState('Player');
  const [identityName, setIdentityName] = useState('Player');
  const [identityAvatarUrl, setIdentityAvatarUrl] = useState('');
  const [identitySaving, setIdentitySaving] = useState(false);
  const [selectedRomId, setSelectedRomId] = useState<string>(NO_ROM_SELECTED);
  const [hostVoiceEnabled, setHostVoiceEnabled] = useState(true);
  const initialInviteValue = searchParams.get('code') ?? '';
  const initialInviteCode = extractInviteCodeInput(initialInviteValue);
  const [joinCodeInput, setJoinCodeInput] = useState(initialInviteCode || initialInviteValue);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [avatarUploadBusy, setAvatarUploadBusy] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentOnlineSession[]>([]);
  const [loadingRecentSessions, setLoadingRecentSessions] = useState(true);
  const [recentSessionsWarning, setRecentSessionsWarning] = useState<string>();
  const [recentSessionsInfo, setRecentSessionsInfo] = useState<string>();
  const [reopeningSessionKey, setReopeningSessionKey] = useState<string>();
  const [recentSearch, setRecentSearch] = useState('');
  const [recentRoleFilter, setRecentRoleFilter] = useState<'all' | 'host' | 'guest'>('all');

  const setTransientInfo = (message: string): void => {
    setRecentSessionsInfo(message);
    window.setTimeout(() => {
      setRecentSessionsInfo((current) => (current === message ? undefined : current));
    }, 2_200);
  };

  useEffect(() => {
    void refreshRoms();
  }, [refreshRoms]);

  useEffect(() => {
    let cancelled = false;
    const loadIdentity = async (): Promise<void> => {
      if (authStatus === 'authenticated' && authUser) {
        setIdentityName(authUser.username);
        setIdentityAvatarUrl(authUser.avatarUrl ?? '');
        setHostName(authUser.username);
        setJoinName(authUser.username);
        return;
      }

      try {
        const profile = await getOnlineIdentityProfile();
        if (cancelled) {
          return;
        }
        setIdentityName(profile.playerName);
        setIdentityAvatarUrl(profile.avatarUrl ?? '');
        setHostName(profile.playerName);
        setJoinName(profile.playerName);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Online profile could not be loaded.';
          setRecentSessionsWarning(message);
        }
      }
    };

    void loadIdentity();
    return () => {
      cancelled = true;
    };
  }, [authStatus, authUser]);

  useEffect(() => {
    let cancelled = false;
    const loadRecentSessions = async (): Promise<void> => {
      try {
        const recent = await getRecentOnlineSessions();
        if (!cancelled) {
          setRecentSessions(recent);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Recent sessions are temporarily unavailable.';
          setRecentSessionsWarning(message);
        }
      } finally {
        if (!cancelled) {
          setLoadingRecentSessions(false);
        }
      }
    };

    void loadRecentSessions();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRom = useMemo(
    () => roms.find((rom) => rom.id === selectedRomId && selectedRomId !== NO_ROM_SELECTED),
    [roms, selectedRomId],
  );
  const normalizedJoinCode = useMemo(() => extractInviteCodeInput(joinCodeInput), [joinCodeInput]);
  const joinCodeFeedback = useMemo(() => {
    if (joinCodeInput.trim().length === 0) {
      return {
        text: 'Paste a 6-character invite code or full invite link.',
        tone: 'status-pill',
      };
    }

    if (normalizedJoinCode.length === 6) {
      return {
        text: `Invite code resolved: ${normalizedJoinCode}`,
        tone: 'status-pill status-good',
      };
    }

    return {
      text: 'Invite code not recognized yet. Keep typing or paste a full link.',
      tone: 'status-pill status-warn',
    };
  }, [joinCodeInput, normalizedJoinCode]);

  const filteredRecentSessions = useMemo(() => {
    const normalizedSearch = recentSearch.trim().toLowerCase();
    return recentSessions.filter((entry) => {
      if (recentRoleFilter !== 'all' && entry.role !== recentRoleFilter) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const haystack = `${entry.code} ${entry.playerName} ${entry.romTitle ?? ''}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [recentRoleFilter, recentSearch, recentSessions]);

  const mostRecentHostSession = useMemo(
    () => recentSessions.find((entry) => entry.role === 'host'),
    [recentSessions],
  );
  const recentSummary = useMemo(() => {
    let hostCount = 0;
    let guestCount = 0;
    let withRomCount = 0;
    for (const entry of recentSessions) {
      if (entry.role === 'host') {
        hostCount += 1;
      } else {
        guestCount += 1;
      }
      if (entry.romTitle) {
        withRomCount += 1;
      }
    }
    return {
      total: recentSessions.length,
      hostCount,
      guestCount,
      withRomCount,
    };
  }, [recentSessions]);
  const hasRecentFilters = recentSearch.trim().length > 0 || recentRoleFilter !== 'all';

  const onSaveIdentity = async (): Promise<void> => {
    if (authStatus === 'authenticated' && authUser) {
      setTransientInfo('Signed-in profile is managed by your account.');
      return;
    }

    setRecentSessionsWarning(undefined);
    setIdentitySaving(true);
    try {
      const normalizedName = normalizePlayerName(identityName, 'Player');
      const avatarUrl = normalizeAvatarUrl(identityAvatarUrl);
      await setOnlineIdentityProfile({
        playerName: normalizedName,
        avatarUrl,
      });
      setIdentityName(normalizedName);
      setIdentityAvatarUrl(avatarUrl ?? '');
      setHostName((current) => (current.trim().length === 0 || current === 'Player 1' || current === 'Player' ? normalizedName : current));
      setJoinName((current) => (current.trim().length === 0 || current === 'Player' || current === 'Player 1' ? normalizedName : current));
      setTransientInfo('Profile saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save online profile.';
      setRecentSessionsWarning(message);
    } finally {
      setIdentitySaving(false);
    }
  };

  const onCreateSession = async (): Promise<void> => {
    setError(undefined);
    setCreating(true);
    try {
      const normalizedHostName = normalizePlayerName(hostName, 'Player 1');
      const avatarUrl = normalizeAvatarUrl(identityAvatarUrl);
      setHostName(normalizedHostName);
      const created = await createOnlineSession({
        hostName: normalizedHostName,
        avatarUrl,
        romId: selectedRom?.id,
        romTitle: selectedRom?.title,
        voiceEnabled: hostVoiceEnabled,
      });
      try {
        await rememberOnlineSession({
          code: created.code,
          clientId: created.clientId,
          playerName: normalizedHostName,
          avatarUrl,
          role: 'host',
          romId: selectedRom?.id,
          romTitle: selectedRom?.title,
        });
      } catch (rememberError) {
        const warning = rememberError instanceof Error ? rememberError.message : 'Could not save recent session locally.';
        setRecentSessionsWarning(warning);
      }
      navigate(`/online/session/${created.code}?clientId=${encodeURIComponent(created.clientId)}`);
    } catch (sessionError) {
      const message = sessionError instanceof Error ? sessionError.message : 'Failed to create session.';
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const onJoinSession = async (): Promise<void> => {
    setError(undefined);
    setJoining(true);
    try {
      const normalizedJoinName = normalizePlayerName(joinName, 'Player');
      const normalizedCode = normalizedJoinCode;
      const avatarUrl = normalizeAvatarUrl(identityAvatarUrl);
      setJoinName(normalizedJoinName);
      setJoinCodeInput(normalizedCode);
      if (normalizedCode.length !== 6) {
        throw new Error('Invite code should be 6 letters/numbers.');
      }
      const joined = await joinOnlineSession({
        code: normalizedCode,
        name: normalizedJoinName,
        avatarUrl,
      });
      try {
        await rememberOnlineSession({
          code: joined.code,
          clientId: joined.clientId,
          playerName: normalizedJoinName,
          avatarUrl,
          role: 'guest',
          romId: joined.session.romId,
          romTitle: joined.session.romTitle,
        });
      } catch (rememberError) {
        const warning = rememberError instanceof Error ? rememberError.message : 'Could not save recent session locally.';
        setRecentSessionsWarning(warning);
      }
      navigate(`/online/session/${joined.code}?clientId=${encodeURIComponent(joined.clientId)}`);
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : 'Failed to join session.';
      setError(message);
    } finally {
      setJoining(false);
    }
  };

  const onPasteInviteFromClipboard = async (): Promise<void> => {
    try {
      const clipboard = await navigator.clipboard.readText();
      const parsedCode = extractInviteCodeInput(clipboard);
      setJoinCodeInput(parsedCode.length === 6 ? parsedCode : clipboard.trim());
      if (parsedCode.length !== 6) {
        setRecentSessionsWarning('Clipboard did not contain a valid invite code or invite link.');
        return;
      }
      setRecentSessionsWarning(undefined);
      setJoinCodeInput(parsedCode);
      setTransientInfo(`Invite code ${parsedCode} pasted.`);
    } catch {
      setRecentSessionsWarning('Could not read clipboard in this browser.');
    }
  };

  const readFileAsDataUrl = async (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Avatar file could not be read.'));
      };
      reader.onerror = () => reject(new Error('Avatar file could not be read.'));
      reader.readAsDataURL(file);
    });

  const onAvatarFileSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setRecentSessionsWarning('Avatar should be an image file (PNG, JPEG, WEBP, GIF).');
      return;
    }

    if (file.size > 1024 * 1024) {
      setRecentSessionsWarning('Avatar image should be 1 MB or smaller.');
      return;
    }

    setAvatarUploadBusy(true);
    setRecentSessionsWarning(undefined);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl.startsWith('data:image/')) {
        throw new Error('Avatar file format is unsupported.');
      }
      if (authStatus === 'authenticated') {
        await uploadAccountAvatar(dataUrl);
        setTransientInfo(`Uploaded avatar from ${file.name}.`);
        return;
      }
      setIdentityAvatarUrl(dataUrl);
      setTransientInfo(`Loaded avatar from ${file.name}. Save profile to keep it.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Avatar could not be loaded.';
      setRecentSessionsWarning(message);
    } finally {
      setAvatarUploadBusy(false);
    }
  };

  const onCopyRecentInviteCode = async (entry: RecentOnlineSession): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.code);
      setTransientInfo(`Copied invite code ${entry.code}.`);
    } catch {
      setRecentSessionsWarning('Could not copy invite code.');
    }
  };

  const onCopyRecentInviteLink = async (entry: RecentOnlineSession): Promise<void> => {
    try {
      const inviteLink = buildInviteJoinUrl(entry.code, window.location.origin);
      await navigator.clipboard.writeText(inviteLink);
      setTransientInfo(`Copied invite link for ${entry.code}.`);
    } catch {
      setRecentSessionsWarning('Could not copy invite link.');
    }
  };

  const onRemoveRecentSession = async (entry: RecentOnlineSession): Promise<void> => {
    const sessionKey = `${entry.code}:${entry.clientId}`;
    if (reopeningSessionKey && reopeningSessionKey !== sessionKey) {
      return;
    }
    setReopeningSessionKey(sessionKey);
    try {
      await removeRecentOnlineSession(entry.code, entry.clientId);
      setRecentSessions((current) =>
        current.filter(
          (sessionEntry) =>
            !(sessionEntry.code === entry.code && sessionEntry.clientId === entry.clientId),
        ),
      );
      setTransientInfo(`Removed ${entry.code} from recent sessions.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not remove recent session.';
      setRecentSessionsWarning(message);
    } finally {
      setReopeningSessionKey(undefined);
    }
  };

  const onReopenSession = async (entry: RecentOnlineSession): Promise<void> => {
    const sessionKey = `${entry.code}:${entry.clientId}`;
    setReopeningSessionKey(sessionKey);
    setError(undefined);
    setRecentSessionsWarning(undefined);

    try {
      const sessionResponse = await getOnlineSession(entry.code);
      const session = sessionResponse.session;

      if (entry.role === 'host') {
        const hostClientId = session.hostClientId;
        await rememberOnlineSession({
          code: session.code,
          clientId: hostClientId,
          playerName: entry.playerName,
          avatarUrl: entry.avatarUrl,
          role: 'host',
          romId: session.romId,
          romTitle: session.romTitle,
        });
        navigate(`/online/session/${session.code}?clientId=${encodeURIComponent(hostClientId)}`);
        return;
      }

      const existingMember = session.members.find((member) => member.clientId === entry.clientId);
      if (existingMember) {
        await rememberOnlineSession({
          code: session.code,
          clientId: entry.clientId,
          playerName: entry.playerName,
          avatarUrl: entry.avatarUrl,
          role: 'guest',
          romId: session.romId,
          romTitle: session.romTitle,
        });
        navigate(`/online/session/${session.code}?clientId=${encodeURIComponent(entry.clientId)}`);
        return;
      }

      const rejoined = await joinOnlineSession({
        code: session.code,
        name: normalizePlayerName(entry.playerName, normalizePlayerName(identityName, 'Player')),
        avatarUrl: entry.avatarUrl ?? normalizeAvatarUrl(identityAvatarUrl),
      });

      await rememberOnlineSession({
        code: rejoined.code,
        clientId: rejoined.clientId,
        playerName: normalizePlayerName(entry.playerName, 'Player'),
        avatarUrl: entry.avatarUrl ?? normalizeAvatarUrl(identityAvatarUrl),
        role: 'guest',
        romId: rejoined.session.romId,
        romTitle: rejoined.session.romTitle,
      });

      navigate(`/online/session/${rejoined.code}?clientId=${encodeURIComponent(rejoined.clientId)}`);
    } catch (reopenError) {
      const message = reopenError instanceof Error ? reopenError.message : 'Could not reopen this session.';
      const sessionMissing = /not found/i.test(message) || /\(404\)/.test(message);
      if (entry.role === 'host' && sessionMissing) {
        try {
          const fallbackHostName = normalizePlayerName(entry.playerName, normalizePlayerName(identityName, 'Player 1'));
          const fallbackAvatarUrl = entry.avatarUrl ?? normalizeAvatarUrl(identityAvatarUrl);
          const fallbackRom = entry.romId ? roms.find((rom) => rom.id === entry.romId) : undefined;
          const created = await createOnlineSession({
            hostName: fallbackHostName,
            avatarUrl: fallbackAvatarUrl,
            romId: fallbackRom?.id ?? entry.romId,
            romTitle: fallbackRom?.title ?? entry.romTitle,
          });
          await rememberOnlineSession({
            code: created.code,
            clientId: created.clientId,
            playerName: fallbackHostName,
            avatarUrl: fallbackAvatarUrl,
            role: 'host',
            romId: fallbackRom?.id ?? entry.romId,
            romTitle: fallbackRom?.title ?? entry.romTitle,
          });
          setTransientInfo('Previous host room expired. Started a fresh host session.');
          navigate(`/online/session/${created.code}?clientId=${encodeURIComponent(created.clientId)}`);
          return;
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : 'Could not create a replacement host session.';
          setError(fallbackMessage);
          return;
        }
      }
      setError(message);
    } finally {
      setReopeningSessionKey(undefined);
    }
  };

  const onClearRecentSessions = async (): Promise<void> => {
    try {
      await clearRecentOnlineSessions();
      setRecentSessions([]);
      setRecentSearch('');
      setRecentRoleFilter('all');
      setRecentSessionsWarning(undefined);
      setTransientInfo('Cleared recent session history.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not clear recent sessions.';
      setRecentSessionsWarning(message);
    }
  };

  return (
    <section className="online-page">
      <header className="panel online-hero-panel">
        <div className="online-hero-grid">
          <div className="online-hero-copy">
            <h1>Online Multiplayer</h1>
            <p>Host runs the ROM as Player 1. Friends join with an invite code and take slots 2-4.</p>
            <p className="online-subtle">Same-room feel with host-authoritative input relay.</p>
            <div className="online-overview-pills" aria-label="Online multiplayer overview">
              <span className="status-pill status-good">Host-authoritative stream</span>
              <span className="status-pill">Invite code join</span>
              <span className="status-pill">Up to 4 players</span>
              <span className="status-pill">Voice chat optional</span>
            </div>
          </div>

          <aside className="online-hero-quickstart" aria-label="Online quick start actions">
            <h2>Quick Start</h2>
            <p>Start or join fast, then move into the live room for stream and voice.</p>
            <div className="wizard-actions online-hero-actions">
              <a href="#online-start-card" className="preset-button online-hero-action-primary">
                Host a Game
              </a>
              <a href="#online-join-card" className="online-hero-action-secondary">
                Join a Game
              </a>
              <Link to="/" className="online-hero-action-secondary">
                Open Library
              </Link>
              {mostRecentHostSession ? (
                <button
                  type="button"
                  className="online-hero-action-secondary"
                  onClick={() => void onReopenSession(mostRecentHostSession)}
                  disabled={Boolean(reopeningSessionKey)}
                >
                  Resume Last Host Room
                </button>
              ) : null}
              {mostRecentHostSession ? (
                <button
                  type="button"
                  className="online-hero-action-secondary"
                  onClick={() => void onCopyRecentInviteLink(mostRecentHostSession)}
                  disabled={Boolean(reopeningSessionKey)}
                >
                  Copy Join Link
                </button>
              ) : null}
            </div>
            <p className="online-subtle">
              Current profile: <strong>{normalizePlayerName(identityName, 'Player')}</strong>
            </p>
          </aside>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        {recentSessionsWarning ? <p className="warning-text">{recentSessionsWarning}</p> : null}
        {recentSessionsInfo ? <p className="online-subtle">{recentSessionsInfo}</p> : null}
      </header>

      <section id="online-profile-card" className="panel online-identity-panel">
        <div className="online-section-headline">
          <h2>Player Profile</h2>
          <span className="status-pill">Auto-used for host/join/reopen</span>
        </div>
        <p className="online-subtle">Your name and avatar are auto-used when starting, joining, and reopening sessions.</p>
        <div className="online-identity-head">
          <OnlineAvatar name={identityName} avatarUrl={identityAvatarUrl} className="online-avatar-preview" />
          <div>
            <p className="online-identity-name">{normalizePlayerName(identityName, 'Player')}</p>
            <p className="online-subtle">
              {authStatus === 'authenticated'
                ? 'Synced from your account. ROM library and controller profiles still stay local on each device.'
                : 'Saved locally on this device.'}
            </p>
          </div>
        </div>
        <div className="online-form-grid">
          <label>
            Display Name
            <input
              type="text"
              value={identityName}
              onChange={(event) => setIdentityName(event.target.value)}
              maxLength={32}
              placeholder="Paul"
              disabled={authStatus === 'authenticated'}
            />
          </label>
          <label>
            Avatar URL (optional)
            <input
              type="url"
              value={identityAvatarUrl}
              onChange={(event) => setIdentityAvatarUrl(event.target.value)}
              placeholder="https://example.com/avatar.png"
              disabled={authStatus === 'authenticated'}
            />
          </label>
        </div>
        <input
          ref={avatarFileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => void onAvatarFileSelected(event)}
          hidden
        />
        <div className="wizard-actions online-identity-actions">
          <button
            type="button"
            onClick={() => void onSaveIdentity()}
            disabled={identitySaving || authStatus === 'authenticated'}
          >
            {identitySaving ? 'Saving…' : 'Save Profile'}
          </button>
          <button
            type="button"
            onClick={() => avatarFileInputRef.current?.click()}
            disabled={identitySaving || avatarUploadBusy}
          >
            {avatarUploadBusy ? 'Loading Avatar…' : 'Upload Avatar'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (authStatus === 'authenticated') {
                void clearAccountAvatar().catch((clearError) => {
                  const message = clearError instanceof Error ? clearError.message : 'Could not clear account avatar.';
                  setRecentSessionsWarning(message);
                });
                return;
              }
              setIdentityAvatarUrl('');
            }}
            disabled={identitySaving || identityAvatarUrl.length === 0}
          >
            Clear Avatar
          </button>
          <button
            type="button"
            onClick={() => {
              const normalized = normalizePlayerName(identityName, 'Player');
              setHostName(normalized);
              setJoinName(normalized);
            }}
          >
            Use Name for Host/Join
          </button>
        </div>
      </section>

      <div className="online-page-grid">
        <section id="online-start-card" className="panel online-card online-card-host">
          <p className="online-card-kicker">Host</p>
          <h2>Start Game</h2>
          <p>Create a session, share the invite code, then launch your ROM as host.</p>
          <form
            className="online-session-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onCreateSession();
            }}
          >
            <div className="online-form-grid">
              <label>
                Host Name
                <input
                  type="text"
                  value={hostName}
                  onChange={(event) => setHostName(event.target.value)}
                  maxLength={32}
                />
              </label>

              <label>
                ROM (optional)
                <select
                  value={selectedRomId}
                  onChange={(event) => setSelectedRomId(event.target.value)}
                >
                  <option value={NO_ROM_SELECTED}>Choose Later in Library</option>
                  {roms.map((rom) => (
                    <option key={rom.id} value={rom.id}>
                      {rom.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="online-subtle">
              {selectedRom
                ? `Session will preselect "${selectedRom.title}".`
                : 'No ROM preselected. You can choose one after session creation.'}
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hostVoiceEnabled}
                onChange={(event) => setHostVoiceEnabled(event.target.checked)}
                disabled={creating || joining}
              />
              Enable lobby voice chat (players start muted and can unmute themselves)
            </label>
            <div className="wizard-actions online-form-actions">
              <button type="submit" className="preset-button online-action-primary" disabled={creating || joining}>
                {creating ? 'Creating…' : 'Start Online Game'}
              </button>
              <button
                type="button"
                className="online-action-secondary"
                onClick={() => setHostName(normalizePlayerName(identityName, 'Player 1'))}
                disabled={creating || joining}
              >
                Use Profile Name
              </button>
              {mostRecentHostSession ? (
                <button
                  type="button"
                  className="online-action-secondary"
                  onClick={() => void onReopenSession(mostRecentHostSession)}
                  disabled={Boolean(reopeningSessionKey)}
                >
                  Resume Last Host Room
                </button>
              ) : null}
              {mostRecentHostSession ? (
                <button
                  type="button"
                  className="online-action-secondary"
                  onClick={() => void onCopyRecentInviteLink(mostRecentHostSession)}
                  disabled={Boolean(reopeningSessionKey)}
                >
                  Copy Join Link
                </button>
              ) : null}
              <Link to="/" className="online-action-link">
                Back to Library
              </Link>
            </div>
          </form>
        </section>

        <section id="online-join-card" className="panel online-card online-card-join">
          <p className="online-card-kicker">Guest</p>
          <h2>Join Game</h2>
          <p>Enter your friend&apos;s invite code to join as the next available player slot.</p>
          <form
            className="online-session-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onJoinSession();
            }}
          >
            <div className="online-form-grid">
              <label>
                Your Name
                <input
                  type="text"
                  value={joinName}
                  onChange={(event) => setJoinName(event.target.value)}
                  maxLength={32}
                />
              </label>

              <label>
                Invite Code
                <input
                  type="text"
                  value={joinCodeInput}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    const parsedCode = extractInviteCodeInput(nextValue);
                    setJoinCodeInput(parsedCode.length === 6 ? parsedCode : nextValue);
                  }}
                  onPaste={(event) => {
                    const pasted = event.clipboardData?.getData('text') ?? '';
                    const parsedCode = extractInviteCodeInput(pasted);
                    if (parsedCode.length !== 6) {
                      return;
                    }
                    event.preventDefault();
                    setJoinCodeInput(parsedCode);
                  }}
                  placeholder="ABC123 or paste invite link"
                  maxLength={320}
                  inputMode="text"
                  autoCapitalize="characters"
                />
              </label>
            </div>
            <div className="online-join-hint">
              <span className={joinCodeFeedback.tone}>{joinCodeFeedback.text}</span>
            </div>
            <div className="wizard-actions online-form-actions">
              <button
                type="submit"
                className="preset-button online-action-primary"
                disabled={joining || creating || normalizedJoinCode.length !== 6}
              >
                {joining ? 'Joining…' : 'Join by Invite Code'}
              </button>
              <button
                type="button"
                className="online-action-secondary"
                onClick={() => void onPasteInviteFromClipboard()}
                disabled={joining || creating}
              >
                Paste Invite
              </button>
              <button
                type="button"
                className="online-action-secondary"
                onClick={() => setJoinName(normalizePlayerName(identityName, 'Player'))}
                disabled={joining || creating}
              >
                Use Profile Name
              </button>
            </div>
          </form>
        </section>
      </div>

      <section id="online-recent-card" className="panel online-recent-panel">
        <div className="online-section-headline">
          <h2>Recent Sessions</h2>
          {recentSessions.length > 0 ? <span className="status-pill">{recentSessions.length} saved</span> : null}
        </div>
        {recentSessions.length > 0 ? (
          <div className="session-status-row recent-session-summary">
            <span className="status-pill">
              {recentSummary.total} total
            </span>
            <span className="status-pill status-good">
              {recentSummary.hostCount} host
            </span>
            <span className="status-pill status-good">
              {recentSummary.guestCount} guest
            </span>
            <span className="status-pill">
              {recentSummary.withRomCount} with ROM
            </span>
          </div>
        ) : null}
        {recentSessions.length > 0 ? (
          <div className="recent-session-toolbar">
            <label>
              Search
              <input
                type="search"
                value={recentSearch}
                onChange={(event) => setRecentSearch(event.target.value)}
                placeholder="Code, player, ROM"
              />
            </label>
            <label>
              Role
              <select
                value={recentRoleFilter}
                onChange={(event) => setRecentRoleFilter(event.target.value as 'all' | 'host' | 'guest')}
              >
                <option value="all">All</option>
                <option value="host">Host only</option>
                <option value="guest">Guest only</option>
              </select>
            </label>
          </div>
        ) : null}
        {loadingRecentSessions ? <p>Loading recent sessions…</p> : null}
        {!loadingRecentSessions && recentSessions.length === 0 ? (
          <p>No recent sessions yet. Start or join a game to populate this list.</p>
        ) : null}
        {!loadingRecentSessions && recentSessions.length > 0 ? (
          <div className="wizard-actions recent-session-quick-actions">
            <button
              type="button"
              onClick={() => void onReopenSession(filteredRecentSessions[0])}
              disabled={filteredRecentSessions.length === 0 || Boolean(reopeningSessionKey)}
            >
              Reopen Latest Match
            </button>
            <button
              type="button"
              onClick={() => {
                setRecentSearch('');
                setRecentRoleFilter('all');
              }}
              disabled={!hasRecentFilters}
            >
              Reset Recent Filters
            </button>
          </div>
        ) : null}
        {!loadingRecentSessions && recentSessions.length > 0 && filteredRecentSessions.length === 0 ? (
          <p>No sessions match your filter.</p>
        ) : null}
        {filteredRecentSessions.length > 0 ? (
          <ul className="recent-session-list">
            {filteredRecentSessions.map((entry) => {
              const sessionKey = `${entry.code}:${entry.clientId}`;
              const reopening = reopeningSessionKey === sessionKey;
              return (
                <li key={sessionKey}>
                  <div className="recent-session-main">
                    <OnlineAvatar name={entry.playerName} avatarUrl={entry.avatarUrl} />
                    <div className="recent-session-meta">
                      <p>
                        <strong>{entry.code}</strong> • {entry.role === 'host' ? 'Host' : 'Guest'} • {entry.playerName}
                      </p>
                      <p className="online-subtle">
                        {entry.romTitle ? `${entry.romTitle} • ` : ''}
                        Last active {new Date(entry.lastActiveAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="recent-session-actions">
                    <button type="button" onClick={() => void onReopenSession(entry)} disabled={reopeningSessionKey !== undefined}>
                      {reopening ? 'Reopening…' : 'Reopen'}
                    </button>
                    <button type="button" onClick={() => void onCopyRecentInviteCode(entry)} disabled={reopeningSessionKey !== undefined}>
                      Copy Code
                    </button>
                    <button type="button" onClick={() => void onCopyRecentInviteLink(entry)} disabled={reopeningSessionKey !== undefined}>
                      Copy Link
                    </button>
                    <button
                      type="button"
                      className="danger-button inline-danger-button"
                      onClick={() => void onRemoveRecentSession(entry)}
                      disabled={reopeningSessionKey !== undefined}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {recentSessions.length > 0 ? (
          <div className="wizard-actions">
            <button type="button" onClick={() => void onClearRecentSessions()}>
              Clear Recent Sessions
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}
