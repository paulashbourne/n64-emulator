import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { getOnlineSession, multiplayerSocketUrl } from '../online/multiplayerApi';
import type {
  MultiplayerMember,
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
} from '../types/multiplayer';

const REMOTE_LOG_LIMIT = 30;

interface RemoteInputEvent {
  fromName: string;
  fromSlot: number;
  at: number;
  payload: unknown;
}

const QUICK_INPUTS: Array<{ label: string; payload: Record<string, unknown> }> = [
  { label: 'A', payload: { control: 'a', pressed: true } },
  { label: 'B', payload: { control: 'b', pressed: true } },
  { label: 'Z', payload: { control: 'z', pressed: true } },
  { label: 'Start', payload: { control: 'start', pressed: true } },
  { label: 'D-Up', payload: { control: 'dpad_up', pressed: true } },
  { label: 'D-Down', payload: { control: 'dpad_down', pressed: true } },
  { label: 'D-Left', payload: { control: 'dpad_left', pressed: true } },
  { label: 'D-Right', payload: { control: 'dpad_right', pressed: true } },
];

function tryParseSocketMessage(raw: string): MultiplayerSocketMessage | null {
  try {
    return JSON.parse(raw) as MultiplayerSocketMessage;
  } catch {
    return null;
  }
}

function slotLabel(slot: number): string {
  return `Player ${slot}`;
}

export function OnlineSessionPage() {
  const { code } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';

  const socketRef = useRef<WebSocket | null>(null);
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [session, setSession] = useState<MultiplayerSessionSnapshot>();
  const [error, setError] = useState<string>();
  const [remoteInputs, setRemoteInputs] = useState<RemoteInputEvent[]>([]);

  const normalizedCode = (code ?? '').toUpperCase();
  const currentMember = useMemo(
    () => session?.members.find((member) => member.clientId === clientId),
    [session, clientId],
  );
  const isHost = currentMember?.isHost ?? false;

  const membersBySlot = useMemo(() => {
    const map = new Map<number, MultiplayerMember>();
    for (const member of session?.members ?? []) {
      map.set(member.slot, member);
    }
    return map;
  }, [session]);

  useEffect(() => {
    if (!normalizedCode) {
      return;
    }

    let cancelled = false;
    const loadSession = async (): Promise<void> => {
      try {
        const snapshot = await getOnlineSession(normalizedCode);
        if (!cancelled) {
          setSession(snapshot.session);
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : 'Failed to load session.';
          setError(message);
        }
      }
    };

    void loadSession();
    const interval = window.setInterval(() => {
      void loadSession();
    }, 4_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [normalizedCode]);

  useEffect(() => {
    if (!normalizedCode || !clientId) {
      return;
    }

    const socket = new WebSocket(multiplayerSocketUrl(normalizedCode, clientId));
    socketRef.current = socket;

    socket.onopen = () => {
      setSocketStatus('connected');
      setError(undefined);
    };

    socket.onmessage = (event) => {
      const message = typeof event.data === 'string' ? tryParseSocketMessage(event.data) : null;
      if (!message) {
        return;
      }

      if (message.type === 'room_state') {
        setSession(message.session);
        return;
      }

      if (message.type === 'remote_input') {
        setRemoteInputs((current) => [
          {
            fromName: message.fromName,
            fromSlot: message.fromSlot,
            at: message.at,
            payload: message.payload,
          },
          ...current,
        ].slice(0, REMOTE_LOG_LIMIT));
      }
    };

    socket.onclose = () => {
      setSocketStatus('disconnected');
    };

    socket.onerror = () => {
      setSocketStatus('disconnected');
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [normalizedCode, clientId]);

  const sendInputEvent = (payload: Record<string, unknown>): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'input',
        payload,
      }),
    );
  };

  const onCopyInviteCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(normalizedCode);
    } catch {
      // Best effort only.
    }
  };

  if (!normalizedCode || !clientId) {
    return (
      <section className="panel">
        <h1>Invalid session link</h1>
        <p>This link is missing a valid invite code or client id.</p>
        <Link to="/online">Back to Online</Link>
      </section>
    );
  }

  return (
    <section className="online-session-page">
      <header className="panel">
        <h1>Online Session {normalizedCode}</h1>
        <p>
          Connection: <strong>{socketStatus}</strong>
        </p>
        {currentMember ? (
          <p>
            You are <strong>{slotLabel(currentMember.slot)}</strong>
            {isHost ? ' (Host)' : ''}
          </p>
        ) : (
          <p className="warning-text">Waiting for player assignment…</p>
        )}
        {session?.romTitle ? <p>Host ROM: {session.romTitle}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        <div className="wizard-actions">
          <button type="button" onClick={() => void onCopyInviteCode()}>
            Copy Invite Code
          </button>
          <Link to="/online">Back to Online</Link>
        </div>
      </header>

      <section className="panel">
        <h2>Players</h2>
        <ul className="room-player-list">
          {[1, 2, 3, 4].map((slot) => {
            const member = membersBySlot.get(slot);
            return (
              <li key={slot}>
                <strong>{slotLabel(slot)}:</strong>{' '}
                {member ? `${member.name}${member.isHost ? ' (Host)' : ''}` : 'Open slot'}
                {member ? ` • ${member.connected ? 'connected' : 'disconnected'}` : ''}
              </li>
            );
          })}
        </ul>
      </section>

      {isHost ? (
        <section className="panel">
          <h2>Host Controls</h2>
          <p>Share invite code <strong>{normalizedCode}</strong> with friends.</p>
          {session?.romId ? (
            <p>
              <Link to={`/play/${encodeURIComponent(session.romId)}`}>Launch Host ROM</Link>
            </p>
          ) : (
            <p>Select/import a ROM from Library and then launch it from Play.</p>
          )}
          <h3>Remote Input Feed</h3>
          {remoteInputs.length === 0 ? <p>No remote input events yet.</p> : null}
          <ul className="remote-input-list">
            {remoteInputs.map((event, index) => (
              <li key={`${event.at}:${index}`}>
                {new Date(event.at).toLocaleTimeString()} • {slotLabel(event.fromSlot)} ({event.fromName}) •{' '}
                <code>{JSON.stringify(event.payload)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="panel">
          <h2>Send Controller Input</h2>
          <p>Use quick test buttons to verify host receives your input events.</p>
          <div className="online-input-grid">
            {QUICK_INPUTS.map((entry) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => sendInputEvent(entry.payload)}
                disabled={socketStatus !== 'connected'}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
