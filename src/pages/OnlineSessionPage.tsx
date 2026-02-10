import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { closeOnlineSession, getOnlineSession, multiplayerSocketUrl } from '../online/multiplayerApi';
import {
  JOINER_KEY_TO_CONTROL,
  buildDigitalInputPayload,
  getPressedControlsFromGamepad,
} from '../online/joinerInput';
import { describeRemoteInputPayload, parseRemoteInputPayload } from '../online/remoteInputBridge';
import {
  buildInviteJoinUrl,
  buildSessionLibraryUrl,
  buildSessionPlayUrl,
  buildSessionRoute,
} from '../online/sessionLinks';
import { useAppStore } from '../state/appStore';
import type {
  MultiplayerMember,
  MultiplayerInputPayload,
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
} from '../types/multiplayer';
import type { N64ControlTarget } from '../types/input';
import type { RomRecord } from '../types/rom';

const REMOTE_LOG_LIMIT = 40;
const SOCKET_RECONNECT_DELAY_MS = 1_500;
const SOCKET_HEARTBEAT_INTERVAL_MS = 10_000;
const CHAT_MAX_LENGTH = 280;
const SESSION_CLOSE_REASON_DEFAULT = 'Session closed.';
const NO_ROOM_ROM = '__none__';

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
  { label: 'L', control: 'l' },
  { label: 'R', control: 'r' },
  { label: 'D-Up', control: 'dpad_up' },
  { label: 'D-Down', control: 'dpad_down' },
  { label: 'D-Left', control: 'dpad_left' },
  { label: 'D-Right', control: 'dpad_right' },
  { label: 'C-Up', control: 'c_up' },
  { label: 'C-Down', control: 'c_down' },
  { label: 'C-Left', control: 'c_left' },
  { label: 'C-Right', control: 'c_right' },
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

function connectionClass(status: 'connecting' | 'connected' | 'disconnected'): string {
  if (status === 'connected') {
    return 'status-pill status-good';
  }
  if (status === 'connecting') {
    return 'status-pill status-warn';
  }
  return 'status-pill status-bad';
}

function latencyClass(latencyMs: number | undefined, connected: boolean): string {
  if (!connected || latencyMs === undefined) {
    return 'status-pill';
  }
  if (latencyMs <= 90) {
    return 'status-pill status-good';
  }
  if (latencyMs <= 170) {
    return 'status-pill status-warn';
  }
  return 'status-pill status-bad';
}

function normalizeSessionSnapshot(session: MultiplayerSessionSnapshot): MultiplayerSessionSnapshot {
  return {
    ...session,
    chat: Array.isArray((session as { chat?: unknown }).chat) ? session.chat : [],
  };
}

function sendInputPayload(socket: WebSocket | null, payload: MultiplayerInputPayload): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'input',
      payload,
    }),
  );
}

export function OnlineSessionPage() {
  const { code } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const roms = useAppStore((state) => state.roms);
  const loadingRoms = useAppStore((state) => state.loadingRoms);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const pendingPingSentAtRef = useRef<number | null>(null);
  const sessionClosedRef = useRef(false);
  const pressedKeyBindingsRef = useRef(new Map<string, N64ControlTarget>());
  const pressedGamepadControlsRef = useRef(new Set<N64ControlTarget>());
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [session, setSession] = useState<MultiplayerSessionSnapshot>();
  const [error, setError] = useState<string>();
  const [clipboardMessage, setClipboardMessage] = useState<string>();
  const [remoteInputs, setRemoteInputs] = useState<RemoteInputEvent[]>([]);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [latencyMs, setLatencyMs] = useState<number>();
  const [sessionClosedReason, setSessionClosedReason] = useState<string>();
  const [endingSession, setEndingSession] = useState(false);
  const [hostRomSelectionId, setHostRomSelectionId] = useState(NO_ROOM_ROM);
  const [savingHostRomSelection, setSavingHostRomSelection] = useState(false);

  const normalizedCode = (code ?? '').toUpperCase();
  const sessionContext =
    normalizedCode.length > 0 && clientId.length > 0
      ? {
          onlineCode: normalizedCode,
          onlineClientId: clientId,
        }
      : undefined;

  const sessionRoute = buildSessionRoute(sessionContext);
  const libraryRoute = buildSessionLibraryUrl(sessionContext);

  const currentMember = session?.members.find((member) => member.clientId === clientId);
  const isHost = currentMember?.isHost ?? false;

  const membersBySlot = useMemo(() => {
    const map = new Map<number, MultiplayerMember>();
    for (const member of session?.members ?? []) {
      map.set(member.slot, member);
    }
    return map;
  }, [session]);

  const connectedPlayers = useMemo(
    () => session?.members.filter((member) => member.connected).length ?? 0,
    [session],
  );

  const inviteJoinUrl =
    typeof window === 'undefined' || normalizedCode.length === 0
      ? ''
      : buildInviteJoinUrl(normalizedCode, window.location.origin);
  const canSendRealtimeInput = socketStatus === 'connected' && !sessionClosedReason;
  const selectedHostRom: RomRecord | undefined =
    hostRomSelectionId === NO_ROOM_ROM ? undefined : roms.find((rom) => rom.id === hostRomSelectionId);

  useEffect(() => {
    if (!isHost) {
      return;
    }
    void refreshRoms();
  }, [isHost, refreshRoms]);

  useEffect(() => {
    setHostRomSelectionId(session?.romId ?? NO_ROOM_ROM);
  }, [session?.romId]);

  useEffect(() => {
    if (!normalizedCode) {
      return;
    }

    let cancelled = false;
    const loadSession = async (): Promise<void> => {
      try {
        const snapshot = await getOnlineSession(normalizedCode);
        if (!cancelled) {
          setSession(normalizeSessionSnapshot(snapshot.session));
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

    let cancelled = false;
    sessionClosedRef.current = false;

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearHeartbeatTimer = (): void => {
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      pendingPingSentAtRef.current = null;
    };

    const sendPing = (socket: WebSocket): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      pendingPingSentAtRef.current = Date.now();
      socket.send(JSON.stringify({ type: 'ping' }));
    };

    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimerRef.current !== null || sessionClosedRef.current) {
        return;
      }

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, SOCKET_RECONNECT_DELAY_MS);
    };

    const connect = (): void => {
      if (cancelled) {
        return;
      }

      setSocketStatus('connecting');
      const socket = new WebSocket(multiplayerSocketUrl(normalizedCode, clientId));
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) {
          return;
        }

        setSocketStatus('connected');
        setSessionClosedReason(undefined);
        setError(undefined);
        setLatencyMs(undefined);
        clearHeartbeatTimer();
        sendPing(socket);

        heartbeatTimerRef.current = window.setInterval(() => {
          sendPing(socket);
        }, SOCKET_HEARTBEAT_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        const message = typeof event.data === 'string' ? tryParseSocketMessage(event.data) : null;
        if (!message) {
          return;
        }

        if (message.type === 'pong') {
          if (pendingPingSentAtRef.current) {
            setLatencyMs(Math.max(1, Date.now() - pendingPingSentAtRef.current));
          }
          return;
        }

        if (message.type === 'room_state') {
          setSession(normalizeSessionSnapshot(message.session));
          return;
        }

        if (message.type === 'remote_input') {
          const parsedPayload = parseRemoteInputPayload(message.payload);
          setRemoteInputs((current) => [
            {
              fromName: message.fromName,
              fromSlot: message.fromSlot,
              at: message.at,
              payload: parsedPayload,
            },
            ...current,
          ].slice(0, REMOTE_LOG_LIMIT));
          return;
        }

        if (message.type === 'chat') {
          setSession((current) => {
            if (!current) {
              return current;
            }
            if (current.chat.some((entry) => entry.id === message.entry.id)) {
              return current;
            }
            return {
              ...current,
              chat: [...current.chat, message.entry].slice(-60),
            };
          });
          return;
        }

        if (message.type === 'session_closed') {
          sessionClosedRef.current = true;
          setSessionClosedReason(message.reason || SESSION_CLOSE_REASON_DEFAULT);
          clearReconnectTimer();
          clearHeartbeatTimer();
          setSocketStatus('disconnected');
          socket.close();
        }
      };

      socket.onclose = () => {
        clearHeartbeatTimer();
        if (cancelled) {
          return;
        }

        setSocketStatus('disconnected');
        if (sessionClosedRef.current) {
          return;
        }
        scheduleReconnect();
      };

      socket.onerror = () => {
        clearHeartbeatTimer();
        if (cancelled) {
          return;
        }
        socket.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      const socket = socketRef.current;
      if (socket) {
        socket.close();
        socketRef.current = null;
      }
    };
  }, [normalizedCode, clientId]);

  const sendQuickTap = (control: N64ControlTarget): void => {
    if (!canSendRealtimeInput) {
      return;
    }

    sendInputPayload(socketRef.current, buildDigitalInputPayload(control, true));

    window.setTimeout(() => {
      sendInputPayload(socketRef.current, buildDigitalInputPayload(control, false));
    }, 80);
  };

  useEffect(() => {
    if (isHost || !canSendRealtimeInput) {
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
      sendInputPayload(socketRef.current, buildDigitalInputPayload(control, true));
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const control = pressedKeyBindingsRef.current.get(event.code) ?? JOINER_KEY_TO_CONTROL[event.code];
      if (!control) {
        return;
      }

      event.preventDefault();
      pressedKeyBindingsRef.current.delete(event.code);
      sendInputPayload(socketRef.current, buildDigitalInputPayload(control, false));
    };

    const releaseAllPressedKeys = (): void => {
      for (const [keyCode, control] of pressedKeyBindingsRef.current.entries()) {
        pressedKeyBindingsRef.current.delete(keyCode);
        sendInputPayload(socketRef.current, buildDigitalInputPayload(control, false));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAllPressedKeys);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAllPressedKeys);
      releaseAllPressedKeys();
    };
  }, [isHost, canSendRealtimeInput]);

  useEffect(() => {
    if (isHost || !canSendRealtimeInput) {
      return;
    }

    let rafHandle = 0;
    let cancelled = false;

    const releaseAllPressedGamepadControls = (): void => {
      for (const control of pressedGamepadControlsRef.current) {
        sendInputPayload(socketRef.current, buildDigitalInputPayload(control, false));
      }
      pressedGamepadControlsRef.current = new Set<N64ControlTarget>();
    };

    const poll = (): void => {
      if (cancelled) {
        return;
      }

      const gamepads = navigator.getGamepads?.() ?? [];
      const activeGamepad = gamepads.find((pad): pad is Gamepad => Boolean(pad)) ?? null;
      setGamepadConnected(Boolean(activeGamepad));

      const nextPressed = getPressedControlsFromGamepad(activeGamepad);
      const previousPressed = pressedGamepadControlsRef.current;

      for (const control of nextPressed) {
        if (!previousPressed.has(control)) {
          sendInputPayload(socketRef.current, buildDigitalInputPayload(control, true));
        }
      }

      for (const control of previousPressed) {
        if (!nextPressed.has(control)) {
          sendInputPayload(socketRef.current, buildDigitalInputPayload(control, false));
        }
      }

      pressedGamepadControlsRef.current = nextPressed;
      rafHandle = window.requestAnimationFrame(poll);
    };

    rafHandle = window.requestAnimationFrame(poll);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafHandle);
      releaseAllPressedGamepadControls();
      setGamepadConnected(false);
    };
  }, [isHost, canSendRealtimeInput]);

  const setClipboardFeedback = (message: string): void => {
    setClipboardMessage(message);
    window.setTimeout(() => {
      setClipboardMessage((current) => (current === message ? undefined : current));
    }, 2_000);
  };

  const onCopyInviteCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(normalizedCode);
      setClipboardFeedback('Invite code copied.');
    } catch {
      setClipboardFeedback('Could not copy invite code.');
    }
  };

  const onCopyInviteLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inviteJoinUrl);
      setClipboardFeedback('Invite link copied.');
    } catch {
      setClipboardFeedback('Could not copy invite link.');
    }
  };

  const onSendChat = (): void => {
    if (!canSendRealtimeInput) {
      return;
    }

    const message = chatDraft.trim();
    if (!message) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before sending chat.');
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'chat',
        text: message.slice(0, CHAT_MAX_LENGTH),
      }),
    );
    setChatDraft('');
  };

  const onSetRoomRom = (): void => {
    if (!isHost) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('Connect to the room before setting ROM selection.');
      return;
    }

    const nextRom = selectedHostRom;
    setSavingHostRomSelection(true);
    socket.send(
      JSON.stringify({
        type: 'host_rom',
        romId: nextRom?.id ?? null,
        romTitle: nextRom?.title ?? null,
      }),
    );

    setSession((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        romId: nextRom?.id,
        romTitle: nextRom?.title,
      };
    });
    setSavingHostRomSelection(false);
    setClipboardFeedback(nextRom ? `Room ROM set to "${nextRom.title}".` : 'Room ROM cleared.');
  };

  const onEndSession = async (): Promise<void> => {
    if (!isHost || !normalizedCode || !clientId) {
      return;
    }

    const confirmed = window.confirm('End this session for all players?');
    if (!confirmed) {
      return;
    }

    setEndingSession(true);
    try {
      await closeOnlineSession({
        code: normalizedCode,
        clientId,
      });
      sessionClosedRef.current = true;
      setSessionClosedReason('You ended the session.');
      const socket = socketRef.current;
      if (socket) {
        socket.close();
      }
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : 'Failed to close session.';
      setError(message);
    } finally {
      setEndingSession(false);
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
        <div className="session-status-row">
          <span className={connectionClass(socketStatus)}>Connection: {socketStatus}</span>
          <span className={latencyClass(latencyMs, socketStatus === 'connected')}>
            Latency: {latencyMs ? `${latencyMs} ms` : socketStatus === 'connected' ? 'Measuring…' : 'Unavailable'}
          </span>
          <span className="status-pill">Players: {connectedPlayers}/4</span>
        </div>
        {currentMember ? (
          <p>
            You are <strong>{slotLabel(currentMember.slot)}</strong>
            {isHost ? ' (Host)' : ''}
          </p>
        ) : (
          <p className="warning-text">Waiting for player assignment…</p>
        )}
        {sessionClosedReason ? <p className="error-text">{sessionClosedReason}</p> : null}
        {session?.romTitle ? <p>Host ROM: {session.romTitle}</p> : <p>No host ROM selected yet.</p>}
        <p>
          Invite code: <strong>{normalizedCode}</strong>
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        {clipboardMessage ? <p className="online-subtle">{clipboardMessage}</p> : null}
        <div className="wizard-actions">
          <button type="button" onClick={() => void onCopyInviteCode()}>
            Copy Invite Code
          </button>
          <button type="button" onClick={() => void onCopyInviteLink()} disabled={!inviteJoinUrl}>
            Copy Invite Link
          </button>
          {isHost ? (
            <button type="button" className="danger-button" onClick={() => void onEndSession()} disabled={endingSession}>
              {endingSession ? 'Ending…' : 'End Session'}
            </button>
          ) : null}
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
          <p>Share code <strong>{normalizedCode}</strong> or your invite link to have friends join instantly.</p>
          <h3>Room ROM</h3>
          {roms.length > 0 ? (
            <div className="room-rom-controls">
              <label>
                Selected ROM
                <select
                  value={hostRomSelectionId}
                  onChange={(event) => setHostRomSelectionId(event.target.value)}
                  disabled={loadingRoms || !canSendRealtimeInput}
                >
                  <option value={NO_ROOM_ROM}>None (clear current room ROM)</option>
                  {roms.map((rom) => (
                    <option key={rom.id} value={rom.id}>
                      {rom.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={onSetRoomRom}
                disabled={!canSendRealtimeInput || savingHostRomSelection}
              >
                {savingHostRomSelection ? 'Saving…' : 'Set Room ROM'}
              </button>
            </div>
          ) : (
            <p className="online-subtle">
              No ROMs in your library yet. <Link to={libraryRoute}>Import or index ROMs first</Link>.
            </p>
          )}
          {session?.romId ? (
            <p>
              <Link to={buildSessionPlayUrl(session.romId, sessionContext)}>
                Launch Host ROM
              </Link>
            </p>
          ) : (
            <p>
              No ROM selected for host yet. <Link to={libraryRoute}>Choose ROM in Library</Link>.
            </p>
          )}
          {sessionRoute ? (
            <p className="online-subtle">
              Returning from Play keeps this session active at <code>{sessionRoute}</code>.
            </p>
          ) : null}
          <h3>Remote Input Feed</h3>
          {remoteInputs.length === 0 ? <p>No remote input events yet.</p> : null}
          <ul className="remote-input-list">
            {remoteInputs.map((event, index) => (
              <li
                key={`${event.at}:${index}`}
                className={event.payload?.pressed ? 'remote-input-down' : 'remote-input-up'}
              >
                {new Date(event.at).toLocaleTimeString()} • {slotLabel(event.fromSlot)} ({event.fromName}) •{' '}
                <code>{describeRemoteInputPayload(event.payload)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="panel">
          <h2>Send Controller Input</h2>
          <p>Use keyboard, gamepad, or quick taps to drive the host emulator in real time.</p>
          <p className="online-subtle">
            Keyboard: <code>X</code> A, <code>C</code> B, <code>Z</code> Z, <code>Enter</code> Start, arrows D-Pad,
            <code> Q/E</code> L/R, <code>I/J/K/L</code> C-buttons.
          </p>
          <p className="online-subtle">
            Gamepad: ABXZ, Start, shoulders, and D-Pad are captured automatically.
            {gamepadConnected ? ' Gamepad connected.' : ' Connect a gamepad to enable capture.'}
          </p>
          <div className="online-input-grid">
            {QUICK_INPUTS.map((entry) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => sendQuickTap(entry.control)}
                disabled={!canSendRealtimeInput}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Session Chat</h2>
        {session?.chat.length ? (
          <ul className="chat-list">
            {session.chat.map((entry) => (
              <li key={entry.id}>
                <p>
                  <strong>{entry.fromName}</strong> ({slotLabel(entry.fromSlot)}) •{' '}
                  {new Date(entry.at).toLocaleTimeString()}
                </p>
                <p>{entry.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No chat messages yet.</p>
        )}
        <form
          className="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSendChat();
          }}
        >
          <label>
            Message
            <input
              type="text"
              value={chatDraft}
              onChange={(event) => setChatDraft(event.target.value)}
              maxLength={CHAT_MAX_LENGTH}
              placeholder="Type a message for everyone in this room…"
              disabled={!canSendRealtimeInput}
            />
          </label>
          <button type="submit" disabled={!canSendRealtimeInput || chatDraft.trim().length === 0}>
            Send
          </button>
        </form>
        <p className="online-subtle">
          {chatDraft.trim().length}/{CHAT_MAX_LENGTH} characters
        </p>
      </section>
    </section>
  );
}
