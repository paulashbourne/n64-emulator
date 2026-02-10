import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ControllerWizard } from '../components/ControllerWizard';
import { applyProfileToRunningEmulator, controllerProfileToEmulatorJsControls } from '../emulator/emulatorJsControls';
import {
  clearEmulatorJsIndexedCaches,
  startEmulatorJs,
  stopEmulatorJs,
  type EmulatorBootMode,
} from '../emulator/emulatorJsRuntime';
import { multiplayerSocketUrl } from '../online/multiplayerApi';
import {
  applyRemoteInputPayloadToHost,
  describeRemoteInputPayload,
  parseRemoteInputPayload,
} from '../online/remoteInputBridge';
import { getRomArrayBuffer, getRomById } from '../roms/catalogService';
import { normalizeRomByteOrder } from '../roms/scanner';
import { getPreferredBootMode, setPreferredBootMode } from '../storage/appSettings';
import { useAppStore } from '../state/appStore';
import type { ControllerProfile } from '../types/input';
import type { MultiplayerSocketMessage } from '../types/multiplayer';
import type { RomRecord } from '../types/rom';

const PLAYER_SELECTOR = '#emulatorjs-player';

type SessionStatus = 'loading' | 'running' | 'paused' | 'error';

function revokeRomBlobUrl(ref: MutableRefObject<string | null>): void {
  if (!ref.current) {
    return;
  }

  URL.revokeObjectURL(ref.current);
  ref.current = null;
}

function tryParseSocketMessage(raw: string): MultiplayerSocketMessage | null {
  try {
    return JSON.parse(raw) as MultiplayerSocketMessage;
  } catch {
    return null;
  }
}

export function PlayPage() {
  const { romId } = useParams<{ romId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const markLastPlayed = useAppStore((state) => state.markLastPlayed);
  const loadProfiles = useAppStore((state) => state.loadProfiles);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const setActiveProfile = useAppStore((state) => state.setActiveProfile);
  const profiles = useAppStore((state) => state.profiles);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const emulatorWarning = useAppStore((state) => state.emulatorWarning);
  const setEmulatorWarning = useAppStore((state) => state.setEmulatorWarning);

  const decodedRomId = romId ? decodeURIComponent(romId) : undefined;
  const onlineCode = (searchParams.get('onlineCode') ?? '').trim().toUpperCase();
  const onlineClientId = (searchParams.get('onlineClientId') ?? '').trim();
  const onlineRelayEnabled = onlineCode.length > 0 && onlineClientId.length > 0;

  const romBlobUrlRef = useRef<string | null>(null);
  const lastAppliedProfileRef = useRef<string | null>(null);
  const onlineSocketRef = useRef<WebSocket | null>(null);
  const onlineReconnectTimerRef = useRef<number | null>(null);
  const onlineRomDescriptorRef = useRef<{ romId?: string; romTitle?: string }>({
    romId: decodedRomId,
    romTitle: undefined,
  });

  const [rom, setRom] = useState<RomRecord>();
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [backendLabel, setBackendLabel] = useState('EmulatorJS');
  const [coreLabel, setCoreLabel] = useState('parallel_n64');
  const [error, setError] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [bootModeLoaded, setBootModeLoaded] = useState(false);
  const [bootNonce, setBootNonce] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [onlineRelayStatus, setOnlineRelayStatus] = useState<'offline' | 'connecting' | 'connected'>(
    onlineRelayEnabled ? 'connecting' : 'offline',
  );
  const [onlineRemoteEventsApplied, setOnlineRemoteEventsApplied] = useState(0);
  const [onlineLastRemoteInput, setOnlineLastRemoteInput] = useState<string>();

  const activeProfile = useMemo<ControllerProfile | undefined>(
    () => profiles.find((profile) => profile.profileId === activeProfileId),
    [profiles, activeProfileId],
  );

  useEffect(() => {
    setEmulatorWarning(undefined);
  }, [decodedRomId, setEmulatorWarning]);

  useEffect(() => {
    let cancelled = false;

    const loadBootMode = async (): Promise<void> => {
      const preferredBootMode = await getPreferredBootMode();
      if (cancelled) {
        return;
      }
      setBootMode(preferredBootMode);
      setBootModeLoaded(true);
    };

    void loadBootMode();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bootModeLoaded) {
      return;
    }

    if (!decodedRomId) {
      setStatus('error');
      setError('Missing ROM id.');
      return;
    }

    let cancelled = false;

    const bootRom = async (): Promise<void> => {
      setStatus('loading');
      setError(undefined);
      setBackendLabel('EmulatorJS');
      setCoreLabel('parallel_n64');
      lastAppliedProfileRef.current = null;

      try {
        const selectedRom = await getRomById(decodedRomId);
        if (!selectedRom) {
          throw new Error('ROM was not found in the catalog.');
        }

        if (cancelled) {
          return;
        }

        setRom(selectedRom);
        await loadProfiles(selectedRom.hash);

        const currentStoreState = useAppStore.getState();
        const selectedProfile = currentStoreState.profiles.find(
          (profile) => profile.profileId === currentStoreState.activeProfileId,
        );

        const romBytes = normalizeRomByteOrder(await getRomArrayBuffer(selectedRom.id));
        const romBlob = new Blob([new Uint8Array(romBytes)], { type: 'application/octet-stream' });
        const romBlobUrl = URL.createObjectURL(romBlob);
        romBlobUrlRef.current = romBlobUrl;

        const started = await startEmulatorJs({
          playerSelector: PLAYER_SELECTOR,
          romUrl: romBlobUrl,
          gameName: selectedRom.title,
          gameId: selectedRom.hash,
          mode: bootMode,
          defaultControls: controllerProfileToEmulatorJsControls(selectedProfile),
          onStart: () => {
            if (!cancelled) {
              setStatus('running');
            }
          },
        });

        if (cancelled) {
          return;
        }

        setBackendLabel(started.source === 'cdn' ? 'EmulatorJS (CDN core path)' : 'EmulatorJS (local core path)');
        setCoreLabel(started.core);
        await markLastPlayed(selectedRom.id);

        if (selectedProfile) {
          lastAppliedProfileRef.current = selectedProfile.profileId;
        }

        setStatus('running');
      } catch (bootError) {
        revokeRomBlobUrl(romBlobUrlRef);
        const message = bootError instanceof Error ? bootError.message : 'Unable to start emulator session.';
        if (!cancelled) {
          setStatus('error');
          setError(message);
        }
      }
    };

    void bootRom();

    return () => {
      cancelled = true;
      stopEmulatorJs(PLAYER_SELECTOR);
      revokeRomBlobUrl(romBlobUrlRef);
    };
  }, [bootMode, bootModeLoaded, bootNonce, decodedRomId, loadProfiles, markLastPlayed]);

  useEffect(() => {
    if (!activeProfile || status === 'error') {
      return;
    }

    if (lastAppliedProfileRef.current === activeProfile.profileId) {
      return;
    }

    const applied = applyProfileToRunningEmulator(activeProfile);
    if (applied) {
      lastAppliedProfileRef.current = activeProfile.profileId;
      setEmulatorWarning(`Applied controller profile: ${activeProfile.name}`);
    }
  }, [activeProfile, setEmulatorWarning, status]);

  useEffect(() => {
    onlineRomDescriptorRef.current = {
      romId: decodedRomId,
      romTitle: rom?.title,
    };

    if (!onlineRelayEnabled) {
      return;
    }

    const socket = onlineSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'host_rom',
        romId: decodedRomId,
        romTitle: rom?.title,
      }),
    );
  }, [decodedRomId, onlineRelayEnabled, rom?.title]);

  useEffect(() => {
    if (!onlineRelayEnabled) {
      setOnlineRelayStatus('offline');
      setOnlineRemoteEventsApplied(0);
      setOnlineLastRemoteInput(undefined);
      return;
    }

    let cancelled = false;

    const clearReconnectTimer = (): void => {
      if (onlineReconnectTimerRef.current !== null) {
        window.clearTimeout(onlineReconnectTimerRef.current);
        onlineReconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (cancelled || onlineReconnectTimerRef.current !== null) {
        return;
      }

      onlineReconnectTimerRef.current = window.setTimeout(() => {
        onlineReconnectTimerRef.current = null;
        connect();
      }, 1_500);
    };

    const connect = (): void => {
      if (cancelled) {
        return;
      }

      setOnlineRelayStatus('connecting');

      const socket = new WebSocket(multiplayerSocketUrl(onlineCode, onlineClientId));
      onlineSocketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) {
          return;
        }

        setOnlineRelayStatus('connected');
        const { romId: activeRomId, romTitle: activeRomTitle } = onlineRomDescriptorRef.current;
        socket.send(
          JSON.stringify({
            type: 'host_rom',
            romId: activeRomId,
            romTitle: activeRomTitle,
          }),
        );
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          return;
        }

        const message = tryParseSocketMessage(event.data);
        if (!message || message.type !== 'remote_input') {
          return;
        }

        const parsedPayload = parseRemoteInputPayload(message.payload);
        const applied = applyRemoteInputPayloadToHost({
          fromSlot: message.fromSlot,
          payload: parsedPayload,
        });
        if (!applied) {
          return;
        }

        setOnlineRemoteEventsApplied((current) => current + 1);
        setOnlineLastRemoteInput(
          `${message.fromName} (${message.fromSlot}) ${describeRemoteInputPayload(parsedPayload)}`,
        );
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }

        setOnlineRelayStatus('connecting');
        scheduleReconnect();
      };

      socket.onerror = () => {
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
      const socket = onlineSocketRef.current;
      if (socket) {
        socket.close();
        onlineSocketRef.current = null;
      }
    };
  }, [onlineClientId, onlineCode, onlineRelayEnabled]);

  const onPauseResume = (): void => {
    const emulator = window.EJS_emulator;
    if (!emulator) {
      return;
    }

    if (status === 'running') {
      emulator.pause?.();
      setStatus('paused');
      return;
    }

    if (status === 'paused') {
      emulator.play?.();
      setStatus('running');
    }
  };

  const onReset = (): void => {
    const emulator = window.EJS_emulator;
    emulator?.gameManager?.restart?.();
  };

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
  };

  const onRetryBoot = (mode: EmulatorBootMode): void => {
    setBootMode(mode);
    void setPreferredBootMode(mode);
    setBootNonce((value) => value + 1);
  };

  const onClearCacheAndRetry = async (): Promise<void> => {
    setClearingCache(true);
    setError(undefined);
    try {
      await clearEmulatorJsIndexedCaches();
      setEmulatorWarning('Cleared EmulatorJS cache. Retrying boot using auto mode.');
      setBootMode('auto');
      await setPreferredBootMode('auto');
      setBootNonce((value) => value + 1);
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Failed to clear EmulatorJS cache.';
      setError(message);
    } finally {
      setClearingCache(false);
    }
  };

  useEffect(() => {
    const togglePause = (): void => {
      const emulator = window.EJS_emulator;
      if (!emulator) {
        return;
      }

      setStatus((currentStatus) => {
        if (currentStatus === 'running') {
          emulator.pause?.();
          return 'paused';
        }
        if (currentStatus === 'paused') {
          emulator.play?.();
          return 'running';
        }
        return currentStatus;
      });
    };

    const resetGame = (): void => {
      const emulator = window.EJS_emulator;
      emulator?.gameManager?.restart?.();
    };

    const onKeydown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.code === 'Escape' && wizardOpen) {
        event.preventDefault();
        setWizardOpen(false);
        return;
      }

      if (status === 'loading' || status === 'error') {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        togglePause();
        return;
      }

      if (event.code === 'KeyR') {
        event.preventDefault();
        resetGame();
        return;
      }

      if (event.code === 'KeyM') {
        event.preventDefault();
        setWizardOpen(true);
      }
    };

    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
    };
  }, [status, wizardOpen]);

  if (!decodedRomId) {
    return (
      <section className="panel">
        <p>Missing ROM id.</p>
        <Link to="/">Back to Library</Link>
      </section>
    );
  }

  return (
    <section className="play-page">
      <header className="panel play-header">
        <div>
          <h1>{rom?.title ?? 'Loading ROM…'}</h1>
          <p>
            Status: {status} • Renderer: {backendLabel}
          </p>
          <p>Core: {coreLabel}</p>
          <p>Boot mode: {bootMode === 'auto' ? 'Auto fallback' : bootMode === 'local' ? 'Local cores only' : 'CDN cores only'}</p>
          {onlineRelayEnabled ? (
            <p>
              Online relay: {onlineRelayStatus} • Code: {onlineCode} • Remote inputs applied: {onlineRemoteEventsApplied}
            </p>
          ) : null}
          {onlineRelayEnabled && onlineLastRemoteInput ? <p>Last remote input: {onlineLastRemoteInput}</p> : null}
          {activeProfile ? <p>Input profile: {activeProfile.name}</p> : <p>No input profile selected.</p>}
        </div>
        <div className="toolbar">
          <button type="button" onClick={onPauseResume} disabled={status === 'loading' || status === 'error'}>
            {status === 'running' ? 'Pause' : 'Resume'}
          </button>
          <button type="button" onClick={onReset} disabled={status === 'loading' || status === 'error'}>
            Reset
          </button>
          <button type="button" onClick={() => setWizardOpen(true)}>
            Map Controller
          </button>
          <button type="button" onClick={() => navigate('/')}>Back to Library</button>
          {onlineRelayEnabled ? (
            <Link to={`/online/session/${onlineCode}?clientId=${encodeURIComponent(onlineClientId)}`}>
              Back to Session
            </Link>
          ) : null}
        </div>
        <p>First launch can take a few seconds while core files initialize.</p>
        <p>Shortcuts: Space pause/resume • R reset • M map controller • Esc close wizard.</p>
        {error ? <p className="error-text">{error}</p> : null}
        {status === 'error' ? (
          <div className="toolbar">
            <button type="button" onClick={() => onRetryBoot('auto')} disabled={clearingCache}>
              Retry (Auto)
            </button>
            <button type="button" onClick={() => onRetryBoot('local')} disabled={clearingCache}>
              Retry (Local Only)
            </button>
            <button type="button" onClick={() => onRetryBoot('cdn')} disabled={clearingCache}>
              Retry (CDN Only)
            </button>
            <button type="button" onClick={() => void onClearCacheAndRetry()} disabled={clearingCache}>
              {clearingCache ? 'Clearing Cache…' : 'Clear Emulator Cache & Retry'}
            </button>
          </div>
        ) : null}
        {emulatorWarning ? <p className="warning-text">{emulatorWarning}</p> : null}
      </header>

      <section className="panel play-canvas-panel">
        <div id="emulatorjs-player" className="ejs-player-host" aria-label="N64 emulator output" />
      </section>

      <section className="panel">
        <h2>Controller Profiles</h2>
        {profiles.length === 0 ? <p>No profiles yet. Open the mapping wizard to create one.</p> : null}

        {profiles.length > 0 ? (
          <label>
            Active profile
            <select
              value={activeProfileId ?? ''}
              onChange={(event) => setActiveProfile(event.target.value || undefined)}
            >
              <option value="">None</option>
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.name}
                  {profile.romHash ? ' (ROM-specific)' : ' (Global)'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            romHash={rom?.hash}
            initialProfile={activeProfile}
            onCancel={() => setWizardOpen(false)}
            onComplete={onProfileComplete}
          />
        </div>
      ) : null}
    </section>
  );
}
