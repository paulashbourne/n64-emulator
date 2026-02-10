import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { getOnlineSession, multiplayerSocketUrl } from '../online/multiplayerApi';
import type {
  MultiplayerMember,
  MultiplayerInputPayload,
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
} from '../types/multiplayer';
import type { N64ControlTarget } from '../types/input';

const REMOTE_LOG_LIMIT = 30;

interface RemoteInputEvent {
  fromName: string;
  fromSlot: number;
  at: number;
  payload: MultiplayerInputPayload | null;
}

const QUICK_INPUTS: Array<{ label: string; control: N64ControlTarget }> = [
  { label: 'A', control: 'a' },
  { label: 'B', control: 'b' },
  { label: 'Z', control: 'z' },
  { label: 'Start', control: 'start' },
  { label: 'D-Up', control: 'dpad_up' },
  { label: 'D-Down', control: 'dpad_down' },
  { label: 'D-Left', control: 'dpad_left' },
  { label: 'D-Right', control: 'dpad_right' },
  { label: 'C-Up', control: 'c_up' },
  { label: 'C-Down', control: 'c_down' },
  { label: 'C-Left', control: 'c_left' },
  { label: 'C-Right', control: 'c_right' },
];

const JOINER_KEY_TO_CONTROL: Record<string, N64ControlTarget> = {
  KeyX: 'a',
  KeyC: 'b',
  KeyZ: 'z',
  Enter: 'start',
  KeyQ: 'l',
  KeyE: 'r',
  ArrowUp: 'dpad_up',
  ArrowDown: 'dpad_down',
  ArrowLeft: 'dpad_left',
  ArrowRight: 'dpad_right',
  KeyI: 'c_up',
  KeyK: 'c_down',
  KeyJ: 'c_left',
  KeyL: 'c_right',
};

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
  const pressedKeyBindingsRef = useRef(new Map<string, N64ControlTarget>());
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

  const sendInputEvent = useCallback((payload: MultiplayerInputPayload): void => {
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
  }, []);

  const sendQuickTap = useCallback((control: N64ControlTarget): void => {
    sendInputEvent({
      kind: 'digital',
      control,
      pressed: true,
    });

    window.setTimeout(() => {
      sendInputEvent({
        kind: 'digital',
        control,
        pressed: false,
      });
    }, 80);
  }, [sendInputEvent]);

  useEffect(() => {
    if (isHost) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      const control = JOINER_KEY_TO_CONTROL[event.code];
      if (!control) {
        return;
      }

      event.preventDefault();
      if (pressedKeyBindingsRef.current.has(event.code)) {
        return;
      }

      pressedKeyBindingsRef.current.set(event.code, control);
      sendInputEvent({
        kind: 'digital',
        control,
        pressed: true,
      });
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const control = pressedKeyBindingsRef.current.get(event.code) ?? JOINER_KEY_TO_CONTROL[event.code];
      if (!control) {
        return;
      }

      event.preventDefault();
      pressedKeyBindingsRef.current.delete(event.code);
      sendInputEvent({
        kind: 'digital',
        control,
        pressed: false,
      });
    };

    const releaseAllPressedControls = (): void => {
      for (const [code, control] of pressedKeyBindingsRef.current.entries()) {
        pressedKeyBindingsRef.current.delete(code);
        sendInputEvent({
          kind: 'digital',
          control,
          pressed: false,
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAllPressedControls);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAllPressedControls);
      releaseAllPressedControls();
    };
  }, [isHost, sendInputEvent]);

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
              <Link
                to={`/play/${encodeURIComponent(session.romId)}?onlineCode=${encodeURIComponent(normalizedCode)}&onlineClientId=${encodeURIComponent(clientId)}`}
              >
                Launch Host ROM
              </Link>
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
          <p>Press mapped keyboard buttons or use quick taps to verify host receives input events.</p>
          <p>
            Keyboard preset: <code>X</code> A, <code>C</code> B, <code>Z</code> Z, <code>Enter</code> Start, arrows D-Pad,
            <code> Q/E</code> L/R, <code>I/J/K/L</code> C-buttons.
          </p>
          <div className="online-input-grid">
            {QUICK_INPUTS.map((entry) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => sendQuickTap(entry.control)}
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
