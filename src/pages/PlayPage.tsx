import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ControllerWizard } from '../components/ControllerWizard';
import { VirtualController } from '../components/VirtualController';
import { applyProfileToRunningEmulator, controllerProfileToEmulatorJsControls } from '../emulator/emulatorJsControls';
import {
  clearEmulatorJsIndexedCaches,
  startEmulatorJs,
  stopEmulatorJs,
  type EmulatorBootMode,
} from '../emulator/emulatorJsRuntime';
import { N64_TARGET_TO_INPUT_INDEX } from '../emulator/n64InputMap';
import { multiplayerSocketUrl } from '../online/multiplayerApi';
import {
  applyRemoteInputPayloadToHost,
  describeRemoteInputPayload,
  parseRemoteInputPayload,
} from '../online/remoteInputBridge';
import { buildInviteJoinUrl, buildSessionLibraryUrl, buildSessionRoute } from '../online/sessionLinks';
import { getRomArrayBuffer, getRomById } from '../roms/catalogService';
import { normalizeRomByteOrder } from '../roms/scanner';
import { getPreferredBootMode, setPreferredBootMode } from '../storage/appSettings';
import { useAppStore } from '../state/appStore';
import type { ControllerProfile, N64ControlTarget } from '../types/input';
import type {
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
  MultiplayerWebRtcSignalPayload,
} from '../types/multiplayer';
import type { RomRecord } from '../types/rom';

const PLAYER_SELECTOR = '#emulatorjs-player';
const ONLINE_HEARTBEAT_INTERVAL_MS = 10_000;
const ONLINE_STREAM_CAPTURE_FPS = 60;
const ONLINE_STREAM_POLL_INTERVAL_MS = 700;
const WEBRTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302'],
    },
  ],
};

type SessionStatus = 'loading' | 'running' | 'paused' | 'error';
type WizardMode = 'create' | 'edit';

interface HostStreamingPeerState {
  connection: RTCPeerConnection;
  negotiationInFlight: boolean;
}

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

function relayStatusClass(status: 'offline' | 'connecting' | 'connected'): string {
  if (status === 'connected') {
    return 'status-pill status-good';
  }
  if (status === 'connecting') {
    return 'status-pill status-warn';
  }
  return 'status-pill status-bad';
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
  const onlineSessionContext = onlineRelayEnabled
    ? {
        onlineCode,
        onlineClientId,
      }
    : undefined;
  const sessionRoute = buildSessionRoute(onlineSessionContext);
  const libraryRoute = buildSessionLibraryUrl(onlineSessionContext);

  const romBlobUrlRef = useRef<string | null>(null);
  const lastAppliedProfileRef = useRef<string | null>(null);
  const playStageRef = useRef<HTMLElement | null>(null);
  const onlineSocketRef = useRef<WebSocket | null>(null);
  const onlineReconnectTimerRef = useRef<number | null>(null);
  const onlineHeartbeatTimerRef = useRef<number | null>(null);
  const onlinePendingPingSentAtRef = useRef<number | null>(null);
  const onlineSessionClosedRef = useRef(false);
  const onlineHostStreamRef = useRef<MediaStream | null>(null);
  const onlineHostPeersRef = useRef<Map<string, HostStreamingPeerState>>(new Map());
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
  const [wizardMode, setWizardMode] = useState<WizardMode>('create');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showVirtualController, setShowVirtualController] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none), (pointer: coarse)').matches
      : false,
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [bootModeLoaded, setBootModeLoaded] = useState(false);
  const [bootNonce, setBootNonce] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [onlineRelayStatus, setOnlineRelayStatus] = useState<'offline' | 'connecting' | 'connected'>(
    onlineRelayEnabled ? 'connecting' : 'offline',
  );
  const [onlineRemoteEventsApplied, setOnlineRemoteEventsApplied] = useState(0);
  const [onlineLastRemoteInput, setOnlineLastRemoteInput] = useState<string>();
  const [onlineConnectedMembers, setOnlineConnectedMembers] = useState(1);
  const [onlineLatencyMs, setOnlineLatencyMs] = useState<number>();
  const [onlineSessionSnapshot, setOnlineSessionSnapshot] = useState<MultiplayerSessionSnapshot>();
  const [onlineStreamPeers, setOnlineStreamPeers] = useState(0);

  const activeProfile = useMemo<ControllerProfile | undefined>(
    () => profiles.find((profile) => profile.profileId === activeProfileId),
    [profiles, activeProfileId],
  );
  const isOnlineHost = onlineRelayEnabled && onlineSessionSnapshot?.hostClientId === onlineClientId;
  const isOnlineHostRef = useRef(false);
  const onlineSessionSnapshotRef = useRef<MultiplayerSessionSnapshot | undefined>(undefined);

  useEffect(() => {
    isOnlineHostRef.current = isOnlineHost;
  }, [isOnlineHost]);

  useEffect(() => {
    onlineSessionSnapshotRef.current = onlineSessionSnapshot;
  }, [onlineSessionSnapshot]);

  const setOnlineStreamPeerCountFromMap = useCallback((): void => {
    setOnlineStreamPeers(onlineHostPeersRef.current.size);
  }, []);

  const closeOnlineHostPeer = useCallback((clientId: string): void => {
    const peerState = onlineHostPeersRef.current.get(clientId);
    if (!peerState) {
      return;
    }

    peerState.connection.onicecandidate = null;
    peerState.connection.onconnectionstatechange = null;
    peerState.connection.ontrack = null;
    peerState.connection.close();
    onlineHostPeersRef.current.delete(clientId);
    setOnlineStreamPeerCountFromMap();
  }, [setOnlineStreamPeerCountFromMap]);

  const clearOnlineHostPeers = useCallback((): void => {
    for (const clientId of Array.from(onlineHostPeersRef.current.keys())) {
      closeOnlineHostPeer(clientId);
    }
    setOnlineStreamPeerCountFromMap();
  }, [closeOnlineHostPeer, setOnlineStreamPeerCountFromMap]);

  const stopOnlineHostStream = useCallback((): void => {
    const stream = onlineHostStreamRef.current;
    if (!stream) {
      return;
    }

    stream.getTracks().forEach((track) => track.stop());
    onlineHostStreamRef.current = null;
  }, []);

  const sendWebRtcSignal = useCallback((targetClientId: string, payload: MultiplayerWebRtcSignalPayload): void => {
    const socket = onlineSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'webrtc_signal',
        targetClientId,
        payload,
      }),
    );
  }, []);

  const ensureHostPeerNegotiation = useCallback((targetClientId: string): void => {
    const peerState = onlineHostPeersRef.current.get(targetClientId);
    if (!peerState || peerState.negotiationInFlight) {
      return;
    }

    peerState.negotiationInFlight = true;
    void (async () => {
      try {
        const offer = await peerState.connection.createOffer();
        await peerState.connection.setLocalDescription(offer);
        const localDescription = peerState.connection.localDescription;
        if (!localDescription?.sdp) {
          return;
        }
        sendWebRtcSignal(targetClientId, {
          kind: 'offer',
          sdp: localDescription.sdp,
        });
      } catch {
        closeOnlineHostPeer(targetClientId);
      } finally {
        const latest = onlineHostPeersRef.current.get(targetClientId);
        if (latest) {
          latest.negotiationInFlight = false;
        }
      }
    })();
  }, [closeOnlineHostPeer, sendWebRtcSignal]);

  const createHostPeerConnection = useCallback((targetClientId: string): RTCPeerConnection => {
    const connection = new RTCPeerConnection(WEBRTC_CONFIGURATION);
    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      sendWebRtcSignal(targetClientId, {
        kind: 'ice_candidate',
        candidate: event.candidate.toJSON(),
      });
    };

    connection.onconnectionstatechange = () => {
      if (
        connection.connectionState === 'failed' ||
        connection.connectionState === 'closed' ||
        connection.connectionState === 'disconnected'
      ) {
        closeOnlineHostPeer(targetClientId);
      }
    };

    return connection;
  }, [closeOnlineHostPeer, sendWebRtcSignal]);

  const attachHostStreamToPeer = useCallback((connection: RTCPeerConnection): boolean => {
    const stream = onlineHostStreamRef.current;
    if (!stream) {
      return false;
    }

    const existingTrackIds = new Set(
      connection
        .getSenders()
        .map((sender) => sender.track?.id)
        .filter((trackId): trackId is string => typeof trackId === 'string'),
    );

    for (const track of stream.getTracks()) {
      if (!existingTrackIds.has(track.id)) {
        connection.addTrack(track, stream);
      }
    }

    return stream.getVideoTracks().length > 0;
  }, []);

  const syncHostStreamingPeers = useCallback((session: MultiplayerSessionSnapshot): void => {
    if (!isOnlineHostRef.current) {
      clearOnlineHostPeers();
      return;
    }

    const connectedGuestMembers = session.members.filter(
      (member) => !member.isHost && member.connected && member.clientId !== onlineClientId,
    );
    const targetIds = new Set(connectedGuestMembers.map((member) => member.clientId));

    for (const existingClientId of Array.from(onlineHostPeersRef.current.keys())) {
      if (!targetIds.has(existingClientId)) {
        closeOnlineHostPeer(existingClientId);
      }
    }

    for (const member of connectedGuestMembers) {
      let peerState = onlineHostPeersRef.current.get(member.clientId);
      if (!peerState) {
        peerState = {
          connection: createHostPeerConnection(member.clientId),
          negotiationInFlight: false,
        };
        onlineHostPeersRef.current.set(member.clientId, peerState);
      }

      const hasVideoTrack = attachHostStreamToPeer(peerState.connection);
      if (hasVideoTrack) {
        ensureHostPeerNegotiation(member.clientId);
      }
    }

    setOnlineStreamPeerCountFromMap();
  }, [
    attachHostStreamToPeer,
    clearOnlineHostPeers,
    closeOnlineHostPeer,
    createHostPeerConnection,
    ensureHostPeerNegotiation,
    onlineClientId,
    setOnlineStreamPeerCountFromMap,
  ]);

  const handleHostWebRtcSignal = useCallback((message: Extract<MultiplayerSocketMessage, { type: 'webrtc_signal' }>): void => {
    if (!isOnlineHostRef.current) {
      return;
    }

    const senderClientId = message.fromClientId;
    let peerState = onlineHostPeersRef.current.get(senderClientId);
    if (!peerState) {
      const memberExists = onlineSessionSnapshotRef.current?.members.some(
        (member) => member.clientId === senderClientId,
      );
      if (!memberExists) {
        return;
      }
      peerState = {
        connection: createHostPeerConnection(senderClientId),
        negotiationInFlight: false,
      };
      onlineHostPeersRef.current.set(senderClientId, peerState);
      attachHostStreamToPeer(peerState.connection);
      setOnlineStreamPeerCountFromMap();
    }

    if (message.payload.kind === 'answer') {
      void peerState.connection
        .setRemoteDescription({
          type: 'answer',
          sdp: message.payload.sdp,
        })
        .catch(() => {
          closeOnlineHostPeer(senderClientId);
        });
      return;
    }

    if (message.payload.kind === 'ice_candidate') {
      void peerState.connection.addIceCandidate(message.payload.candidate).catch(() => {
        closeOnlineHostPeer(senderClientId);
      });
    }
  }, [
    attachHostStreamToPeer,
    closeOnlineHostPeer,
    createHostPeerConnection,
    setOnlineStreamPeerCountFromMap,
  ]);

  const tryStartHostStreamCapture = useCallback((): boolean => {
    if (!isOnlineHostRef.current) {
      return false;
    }

    const existingStream = onlineHostStreamRef.current;
    if (existingStream?.getVideoTracks().some((track) => track.readyState === 'live')) {
      return true;
    }

    const playerCanvas = document.querySelector(`${PLAYER_SELECTOR} canvas`);
    if (!(playerCanvas instanceof HTMLCanvasElement) || typeof playerCanvas.captureStream !== 'function') {
      return false;
    }

    const capturedStream = playerCanvas.captureStream(ONLINE_STREAM_CAPTURE_FPS);
    const videoTrack = capturedStream.getVideoTracks()[0];
    if (!videoTrack) {
      capturedStream.getTracks().forEach((track) => track.stop());
      return false;
    }

    stopOnlineHostStream();
    onlineHostStreamRef.current = capturedStream;
    if (onlineSessionSnapshotRef.current) {
      syncHostStreamingPeers(onlineSessionSnapshotRef.current);
    }
    return true;
  }, [stopOnlineHostStream, syncHostStreamingPeers]);

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
      setOnlineConnectedMembers(1);
      setOnlineLatencyMs(undefined);
      setOnlineSessionSnapshot(undefined);
      clearOnlineHostPeers();
      stopOnlineHostStream();
      onlineSessionClosedRef.current = false;
      return;
    }

    let cancelled = false;
    onlineSessionClosedRef.current = false;

    const clearReconnectTimer = (): void => {
      if (onlineReconnectTimerRef.current !== null) {
        window.clearTimeout(onlineReconnectTimerRef.current);
        onlineReconnectTimerRef.current = null;
      }
    };

    const clearHeartbeatTimer = (): void => {
      if (onlineHeartbeatTimerRef.current !== null) {
        window.clearInterval(onlineHeartbeatTimerRef.current);
        onlineHeartbeatTimerRef.current = null;
      }
      onlinePendingPingSentAtRef.current = null;
    };

    const sendPing = (socket: WebSocket): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      onlinePendingPingSentAtRef.current = Date.now();
      socket.send(JSON.stringify({ type: 'ping' }));
    };

    const scheduleReconnect = (): void => {
      if (cancelled || onlineReconnectTimerRef.current !== null || onlineSessionClosedRef.current) {
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
        setOnlineLatencyMs(undefined);
        const { romId: activeRomId, romTitle: activeRomTitle } = onlineRomDescriptorRef.current;
        socket.send(
          JSON.stringify({
            type: 'host_rom',
            romId: activeRomId,
            romTitle: activeRomTitle,
          }),
        );
        clearHeartbeatTimer();
        sendPing(socket);
        onlineHeartbeatTimerRef.current = window.setInterval(() => {
          sendPing(socket);
        }, ONLINE_HEARTBEAT_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          return;
        }

        const message = tryParseSocketMessage(event.data);
        if (!message) {
          return;
        }

        if (message.type === 'pong') {
          if (onlinePendingPingSentAtRef.current) {
            setOnlineLatencyMs(Math.max(1, Date.now() - onlinePendingPingSentAtRef.current));
          }
          return;
        }

        if (message.type === 'room_state') {
          const connectedMembers = message.session.members.filter((member) => member.connected).length;
          setOnlineSessionSnapshot(message.session);
          setOnlineConnectedMembers(Math.max(connectedMembers, 1));
          syncHostStreamingPeers(message.session);
          return;
        }

        if (message.type === 'webrtc_signal') {
          handleHostWebRtcSignal(message);
          return;
        }

        if (message.type === 'session_closed') {
          onlineSessionClosedRef.current = true;
          clearReconnectTimer();
          clearHeartbeatTimer();
          setOnlineRelayStatus('offline');
          setOnlineSessionSnapshot(undefined);
          clearOnlineHostPeers();
          stopOnlineHostStream();
          setEmulatorWarning(message.reason || 'Online session closed.');
          socket.close();
          return;
        }

        if (message.type !== 'remote_input') {
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
        clearHeartbeatTimer();
        if (cancelled) {
          return;
        }
        if (onlineSessionClosedRef.current) {
          setOnlineRelayStatus('offline');
          setOnlineSessionSnapshot(undefined);
          return;
        }
        setOnlineRelayStatus('connecting');
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
      clearOnlineHostPeers();
      stopOnlineHostStream();
      const socket = onlineSocketRef.current;
      if (socket) {
        socket.close();
        onlineSocketRef.current = null;
      }
    };
  }, [
    clearOnlineHostPeers,
    handleHostWebRtcSignal,
    onlineClientId,
    onlineCode,
    onlineRelayEnabled,
    setEmulatorWarning,
    stopOnlineHostStream,
    syncHostStreamingPeers,
  ]);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      clearOnlineHostPeers();
      stopOnlineHostStream();
      return;
    }

    if (status === 'error') {
      return;
    }

    if (tryStartHostStreamCapture()) {
      if (onlineSessionSnapshot) {
        syncHostStreamingPeers(onlineSessionSnapshot);
      }
      return;
    }

    const timer = window.setInterval(() => {
      const started = tryStartHostStreamCapture();
      if (!started) {
        return;
      }
      if (onlineSessionSnapshot) {
        syncHostStreamingPeers(onlineSessionSnapshot);
      }
      window.clearInterval(timer);
    }, ONLINE_STREAM_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    clearOnlineHostPeers,
    isOnlineHost,
    onlineRelayEnabled,
    onlineSessionSnapshot,
    status,
    stopOnlineHostStream,
    syncHostStreamingPeers,
    tryStartHostStreamCapture,
  ]);

  useEffect(() => {
    const onFullscreenChange = (): void => {
      const stage = playStageRef.current;
      if (!stage) {
        setIsFullscreen(false);
        return;
      }
      setIsFullscreen(document.fullscreenElement === stage);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

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

  const onVirtualControlChange = (control: N64ControlTarget, pressed: boolean): void => {
    const emulator = window.EJS_emulator;
    const simulateInput = emulator?.gameManager?.simulateInput ?? emulator?.gameManager?.functions?.simulateInput;
    if (typeof simulateInput !== 'function') {
      return;
    }

    const inputIndex = N64_TARGET_TO_INPUT_INDEX[control];
    if (typeof inputIndex !== 'number') {
      return;
    }

    simulateInput(0, inputIndex, pressed ? 1 : 0);
  };

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
    setWizardMode('create');
  };

  const openCreateWizard = (): void => {
    setWizardMode('create');
    setWizardOpen(true);
    setMenuOpen(true);
  };

  const openEditWizard = (): void => {
    if (!activeProfile) {
      openCreateWizard();
      return;
    }
    setWizardMode('edit');
    setWizardOpen(true);
    setMenuOpen(true);
  };

  const onToggleFullscreen = async (): Promise<void> => {
    const stage = playStageRef.current;
    if (!stage) {
      return;
    }

    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
        return;
      }

      await stage.requestFullscreen();
    } catch {
      setEmulatorWarning('Fullscreen is unavailable in this browser context.');
    }
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

  const onCopyInviteLink = async (): Promise<void> => {
    if (!onlineRelayEnabled) {
      return;
    }

    try {
      const inviteUrl = buildInviteJoinUrl(onlineCode, window.location.origin);
      await navigator.clipboard.writeText(inviteUrl);
      setEmulatorWarning('Invite link copied to clipboard.');
    } catch {
      setEmulatorWarning('Unable to copy invite link automatically. Copy the invite code manually.');
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
        setWizardMode('create');
        return;
      }

      if (event.code === 'Escape' && menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
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
        setWizardMode('create');
        setWizardOpen(true);
        setMenuOpen(true);
        return;
      }

      if (event.code === 'KeyO') {
        event.preventDefault();
        setMenuOpen((value) => !value);
      }
    };

    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
    };
  }, [menuOpen, status, wizardOpen]);

  if (!decodedRomId) {
    return (
      <section className="panel">
        <p>Missing ROM id.</p>
        <Link to="/">Back to Library</Link>
      </section>
    );
  }

  return (
    <section
      className={`play-page ${menuOpen ? 'play-menu-open' : ''} ${showVirtualController ? 'play-has-virtual-controller' : ''}`}
    >
      <section ref={playStageRef} className="play-stage">
        <div className="play-overlay-top">
          <div className="play-overlay-left">
            <button
              type="button"
              className="play-menu-toggle"
              onClick={() => setMenuOpen((value) => !value)}
            >
              {menuOpen ? 'Hide Menu' : 'Menu'}
            </button>
            <div className="play-overlay-meta">
              <h1>{rom?.title ?? 'Loading ROM…'}</h1>
              <p>
                {status === 'loading'
                  ? 'Loading'
                  : status === 'running'
                    ? 'Running'
                    : status === 'paused'
                      ? 'Paused'
                      : 'Error'}{' '}
                • {onlineRelayEnabled ? `Online ${onlineCode}` : 'Local Play'}
              </p>
            </div>
          </div>
          <div className="play-overlay-actions">
            <button type="button" onClick={onPauseResume} disabled={status === 'loading' || status === 'error'}>
              {status === 'running' ? 'Pause' : 'Resume'}
            </button>
            <button type="button" onClick={onReset} disabled={status === 'loading' || status === 'error'}>
              Reset
            </button>
            <button type="button" onClick={() => setShowVirtualController((value) => !value)}>
              {showVirtualController ? 'Hide Virtual Pad' : 'Show Virtual Pad'}
            </button>
            <button type="button" onClick={() => void onToggleFullscreen()}>
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
          </div>
        </div>

        <div className="play-stage-surface">
          <div id="emulatorjs-player" className="ejs-player-host ejs-player-host-focus" aria-label="N64 emulator output" />
        </div>

        <div className="play-overlay-bottom">
          <p>Shortcuts: Space pause/resume • R reset • M map controller • O menu • Esc close overlays.</p>
          {error ? <p className="error-text">{error}</p> : null}
          {emulatorWarning ? <p className="warning-text">{emulatorWarning}</p> : null}
        </div>
      </section>

      {menuOpen ? (
        <button
          type="button"
          className="play-menu-backdrop"
          aria-label="Close game menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <aside className={`play-side-menu ${menuOpen ? 'open' : ''}`} aria-label="Play menu">
        <header className="play-side-header">
          <h2>Game Menu</h2>
          <button type="button" onClick={() => setMenuOpen(false)}>
            Close
          </button>
        </header>

        <div className="play-side-section">
          <p className="online-subtle">
            {onlineRelayEnabled
              ? 'Host-authoritative relay is active. This panel includes host diagnostics and session tools.'
              : 'Local play focus mode keeps the game front and center. Use this menu for controls and profiles.'}
          </p>
          <div className="wizard-actions">
            <button type="button" onClick={() => navigate(libraryRoute)}>
              Back to Library
            </button>
            <button type="button" onClick={() => setShowVirtualController((value) => !value)}>
              {showVirtualController ? 'Hide Virtual Controller' : 'Show Virtual Controller'}
            </button>
            {onlineRelayEnabled && sessionRoute ? <Link to={sessionRoute}>Back to Session</Link> : null}
            {onlineRelayEnabled ? (
              <button type="button" onClick={() => void onCopyInviteLink()}>
                Copy Invite Link
              </button>
            ) : null}
          </div>
        </div>

        {onlineRelayEnabled ? (
          <section className="play-side-section">
            <h3>Online Status</h3>
            <div className="session-status-row">
              <span className={relayStatusClass(onlineRelayStatus)}>Relay: {onlineRelayStatus}</span>
              <span className="status-pill">Players: {onlineConnectedMembers}/4</span>
              <span className="status-pill">Remote events: {onlineRemoteEventsApplied}</span>
              <span className="status-pill">Code: {onlineCode}</span>
              {isOnlineHost ? <span className="status-pill">Stream viewers: {onlineStreamPeers}</span> : null}
              <span
                className={
                  onlineLatencyMs
                    ? onlineLatencyMs <= 90
                      ? 'status-pill status-good'
                      : onlineLatencyMs <= 170
                        ? 'status-pill status-warn'
                        : 'status-pill status-bad'
                    : 'status-pill'
                }
              >
                Latency:{' '}
                {onlineLatencyMs
                  ? `${onlineLatencyMs} ms`
                  : onlineRelayStatus === 'connected'
                    ? 'Measuring…'
                    : 'Unavailable'}
              </span>
            </div>
            {onlineLastRemoteInput ? <p className="online-subtle">Last remote input: {onlineLastRemoteInput}</p> : null}
            {isOnlineHost ? (
              <p className="online-subtle">
                Host stream source: emulator canvas ({ONLINE_STREAM_CAPTURE_FPS} fps target, video-only stream path).
              </p>
            ) : (
              <p className="warning-text">Only Player 1 host should run the emulator on this page.</p>
            )}
          </section>
        ) : null}

        <section className="play-side-section">
          <h3>Controller Profiles</h3>
          {profiles.length === 0 ? <p>No profiles yet. Create one to map controls.</p> : null}
          {profiles.length > 0 ? (
            <label>
              Active profile
              <select value={activeProfileId ?? ''} onChange={(event) => setActiveProfile(event.target.value || undefined)}>
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
          <div className="wizard-actions">
            <button type="button" onClick={openCreateWizard}>
              New Profile
            </button>
            <button type="button" onClick={openEditWizard} disabled={!activeProfile}>
              Edit Active
            </button>
          </div>
          {activeProfile ? (
            <p className="online-subtle">
              Active: {activeProfile.name} • Device {activeProfile.deviceId} • Deadzone {activeProfile.deadzone.toFixed(2)}
            </p>
          ) : null}
        </section>

        <section className="play-side-section">
          <h3>Emulator Runtime</h3>
          <p>Renderer: {backendLabel}</p>
          <p>Core: {coreLabel}</p>
          <p>Boot mode: {bootMode === 'auto' ? 'Auto fallback' : bootMode === 'local' ? 'Local cores only' : 'CDN cores only'}</p>
          <p>First launch can take a few seconds while emulator assets initialize.</p>
        </section>

        {status === 'error' ? (
          <section className="play-side-section">
            <h3>Recovery</h3>
            <div className="wizard-actions">
              <button type="button" onClick={() => onRetryBoot('auto')} disabled={clearingCache}>
                Retry (Auto)
              </button>
              <button type="button" onClick={() => onRetryBoot('local')} disabled={clearingCache}>
                Retry (Local)
              </button>
              <button type="button" onClick={() => onRetryBoot('cdn')} disabled={clearingCache}>
                Retry (CDN)
              </button>
              <button type="button" onClick={() => void onClearCacheAndRetry()} disabled={clearingCache}>
                {clearingCache ? 'Clearing Cache…' : 'Clear Cache & Retry'}
              </button>
            </div>
          </section>
        ) : null}
      </aside>

      {showVirtualController ? (
        <div className="virtual-controller-dock">
          <VirtualController disabled={status === 'loading' || status === 'error'} onControlChange={onVirtualControlChange} />
        </div>
      ) : null}

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            romHash={rom?.hash}
            initialProfile={wizardMode === 'edit' ? activeProfile : undefined}
            onCancel={() => {
              setWizardOpen(false);
              setWizardMode('create');
            }}
            onComplete={onProfileComplete}
          />
        </div>
      ) : null}
    </section>
  );
}
