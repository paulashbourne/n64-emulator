import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { createOnlineSession, joinOnlineSession } from '../online/multiplayerApi';
import {
  clearRecentOnlineSessions,
  getRecentOnlineSessions,
  rememberOnlineSession,
  type RecentOnlineSession,
} from '../storage/appSettings';
import { useAppStore } from '../state/appStore';

const NO_ROM_SELECTED = '__none__';

function normalizePlayerName(name: string, fallback: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim().slice(0, 32);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function OnlinePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const roms = useAppStore((state) => state.roms);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const [hostName, setHostName] = useState('Player 1');
  const [joinName, setJoinName] = useState('Player');
  const [selectedRomId, setSelectedRomId] = useState<string>(NO_ROM_SELECTED);
  const [joinCode, setJoinCode] = useState(normalizeInviteCode(searchParams.get('code') ?? ''));
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentOnlineSession[]>([]);
  const [loadingRecentSessions, setLoadingRecentSessions] = useState(true);
  const [recentSessionsWarning, setRecentSessionsWarning] = useState<string>();

  useEffect(() => {
    void refreshRoms();
  }, [refreshRoms]);

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

  const onCreateSession = async (): Promise<void> => {
    setError(undefined);
    setCreating(true);
    try {
      const normalizedHostName = normalizePlayerName(hostName, 'Player 1');
      setHostName(normalizedHostName);
      const created = await createOnlineSession({
        hostName: normalizedHostName,
        romId: selectedRom?.id,
        romTitle: selectedRom?.title,
      });
      try {
        await rememberOnlineSession({
          code: created.code,
          clientId: created.clientId,
          playerName: normalizedHostName,
          role: 'host',
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
      const normalizedCode = normalizeInviteCode(joinCode);
      setJoinName(normalizedJoinName);
      setJoinCode(normalizedCode);
      if (normalizedCode.length !== 6) {
        throw new Error('Invite code should be 6 letters/numbers.');
      }
      const joined = await joinOnlineSession({
        code: normalizedCode,
        name: normalizedJoinName,
      });
      try {
        await rememberOnlineSession({
          code: joined.code,
          clientId: joined.clientId,
          playerName: normalizedJoinName,
          role: 'guest',
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

  const onClearRecentSessions = async (): Promise<void> => {
    try {
      await clearRecentOnlineSessions();
      setRecentSessions([]);
      setRecentSessionsWarning(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not clear recent sessions.';
      setRecentSessionsWarning(message);
    }
  };

  return (
    <section className="online-page">
      <header className="panel">
        <h1>Online Multiplayer</h1>
        <p>Host runs the ROM as Player 1. Friends join with an invite code and take slots 2-4.</p>
        <p>
          <strong>Architecture:</strong> central coordinator + host-authoritative input relay.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        {recentSessionsWarning ? <p className="warning-text">{recentSessionsWarning}</p> : null}
      </header>

      <div className="online-page-grid">
        <section className="panel online-card">
          <h2>Start Game</h2>
          <p>Create a session, share the invite code, then launch your ROM as host.</p>
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
          <div className="wizard-actions">
            <button type="button" onClick={() => void onCreateSession()} disabled={creating || joining}>
              {creating ? 'Creating…' : 'Start Online Game'}
            </button>
            <Link to="/">Back to Library</Link>
          </div>
        </section>

        <section className="panel online-card">
          <h2>Join Game</h2>
          <p>Enter your friend&apos;s invite code to join as the next available player slot.</p>
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
                value={joinCode}
                onChange={(event) => setJoinCode(normalizeInviteCode(event.target.value))}
                placeholder="ABC123"
                maxLength={6}
              />
            </label>
          </div>
          <div className="wizard-actions">
            <button type="button" onClick={() => void onJoinSession()} disabled={joining || creating || joinCode.trim().length !== 6}>
              {joining ? 'Joining…' : 'Join by Invite Code'}
            </button>
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Recent Sessions</h2>
        {loadingRecentSessions ? <p>Loading recent sessions…</p> : null}
        {!loadingRecentSessions && recentSessions.length === 0 ? (
          <p>No recent sessions yet. Start or join a game to populate this list.</p>
        ) : null}
        {recentSessions.length > 0 ? (
          <ul className="recent-session-list">
            {recentSessions.map((entry) => (
              <li key={`${entry.code}:${entry.clientId}`}>
                <div>
                  <p>
                    <strong>{entry.code}</strong> • {entry.role === 'host' ? 'Host' : 'Guest'} • {entry.playerName}
                  </p>
                  <p className="online-subtle">
                    {entry.romTitle ? `${entry.romTitle} • ` : ''}
                    Last active {new Date(entry.lastActiveAt).toLocaleString()}
                  </p>
                </div>
                <Link to={`/online/session/${entry.code}?clientId=${encodeURIComponent(entry.clientId)}`}>
                  Reopen
                </Link>
              </li>
            ))}
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
