import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ControllerWizard } from '../components/ControllerWizard';
import { InSessionSettingsModal } from '../components/InSessionSettingsModal';
import { VirtualController } from '../components/VirtualController';
import { closeOnlineSession, getOnlineSession, kickOnlineMember, multiplayerSocketUrl } from '../online/multiplayerApi';
import { buildAnalogInputPayload, buildDigitalInputPayload } from '../online/joinerInput';
import { describeRemoteInputPayload, parseRemoteInputPayload } from '../online/remoteInputBridge';
import {
  buildInviteJoinUrl,
  buildSessionLibraryUrl,
  buildSessionPlayUrl,
  buildSessionRoute,
} from '../online/sessionLinks';
import { WEBRTC_CONFIGURATION } from '../online/webrtcConfig';
import { createInputPoller } from '../input/inputService';
import { useAppStore } from '../state/appStore';
import type {
  HostStreamQualityPresetHint,
  MultiplayerDigitalInputPayload,
  MultiplayerMember,
  MultiplayerInputPayload,
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
} from '../types/multiplayer';
import type { ControllerProfile, N64ControlTarget, N64DigitalTarget } from '../types/input';
import type { RomRecord } from '../types/rom';

const REMOTE_LOG_LIMIT = 40;
const SOCKET_RECONNECT_DELAY_MS = 1_500;
const SOCKET_HEARTBEAT_INTERVAL_MS = 10_000;
const SESSION_SNAPSHOT_POLL_MS_CONNECTED = 15_000;
const SESSION_SNAPSHOT_POLL_MS_DISCONNECTED = 4_000;
const GUEST_STREAM_STATS_INTERVAL_MS = 2_000;
const GUEST_AUTO_RESYNC_AFTER_STALL_MS = 3_500;
const GUEST_RESYNC_REQUEST_COOLDOWN_MS = 3_000;
const GUEST_BOOTSTRAP_RESYNC_DELAY_MS = 2_500;
const GUEST_BOOTSTRAP_RESYNC_COOLDOWN_MS = 12_000;
const GUEST_STALL_PROBE_INTERVAL_MS = 1_000;
const GUEST_STALL_NO_PROGRESS_MS = 3_200;
const GUEST_STALL_RECOVERY_COOLDOWN_MS = 8_000;
const GUEST_STALL_WARMUP_GRACE_MS = 4_500;
const GUEST_VIDEO_JITTER_TARGET_DEFAULT_MS = 22;
const GUEST_VIDEO_JITTER_TARGET_RECOVERY_MS = 34;
const GUEST_PLAYBACK_CATCH_UP_RATE = 1.04;
const GUEST_PLAYBACK_CATCH_UP_MIN_BUFFER_MS = 110;
const GUEST_PLAYBACK_CATCH_UP_MAX_BUFFER_MS = 900;
const READY_AUTO_LAUNCH_COUNTDOWN_SECONDS = 3;
const REMOTE_ANALOG_ZERO_THRESHOLD = 0.015;
const REMOTE_ANALOG_LOG_COALESCE_MS = 220;
const QUALITY_HINT_REQUEST_COOLDOWN_MS = 5_000;
const AUTO_QUALITY_HINT_MIN_INTERVAL_MS = 20_000;
const AUTO_QUALITY_HINT_REPEAT_INTERVAL_MS = 60_000;
const AUTO_QUALITY_HINT_STABILITY_MS = 6_000;
const LATENCY_HISTORY_LIMIT = 24;
const LATENCY_RESCUE_COOLDOWN_MS = 8_000;
const HOST_READY_CHECK_COOLDOWN_MS = 10_000;
const CHAT_MAX_LENGTH = 280;
const SESSION_CLOSE_REASON_DEFAULT = 'Session closed.';
const NO_ROOM_ROM = '__none__';
const ONLINE_SESSION_VIEW_PREFS_KEY = 'online_session_view_prefs_v4';
const ONLINE_ADVANCED_TOOLS_STORAGE_KEY = 'online_session_advanced_tools_v5';
const REMOTE_FEED_UI_FLUSH_MS_VISIBLE = 90;
const REMOTE_FEED_UI_FLUSH_MS_BACKGROUND = 320;
const REMOTE_FEED_PAUSED_COUNT_FLUSH_MS = 180;
const ONLINE_COMPACT_VIEWPORT_MAX_WIDTH = 960;
const ONLINE_PHONE_VIEWPORT_MAX_WIDTH = 720;

type HostStreamStatus = 'idle' | 'connecting' | 'live' | 'error';
type WizardMode = 'create' | 'edit';
type GuestInputRelayMode = 'auto' | 'responsive' | 'balanced' | 'conservative';
type EffectiveGuestInputRelayMode = Exclude<GuestInputRelayMode, 'auto'>;
type HostQualityHintRequestSource = 'manual' | 'auto' | 'rescue';
type GuestLayoutPreset = 'stream' | 'controls' | 'all';
type HostRemoteFeedFilterKind = 'all' | 'digital' | 'analog' | 'unknown';
type HostRemoteFeedSlotFilter = 'all' | 2 | 3 | 4;
type WebRtcSignalMessage = Extract<MultiplayerSocketMessage, { type: 'webrtc_signal' }>;

const DIGITAL_TARGETS: N64DigitalTarget[] = [
  'a',
  'b',
  'z',
  'start',
  'l',
  'r',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'c_up',
  'c_down',
  'c_left',
  'c_right',
];

interface RemoteInputEvent {
  fromName: string;
  fromSlot: number;
  at: number;
  payload: MultiplayerInputPayload | null;
}

function appendRemoteInputEvent(current: RemoteInputEvent[], nextEvent: RemoteInputEvent): RemoteInputEvent[] {
  const latest = current[0];
  if (
    nextEvent.payload?.kind === 'analog' &&
    latest &&
    latest.payload?.kind === 'analog' &&
    latest.fromSlot === nextEvent.fromSlot &&
    nextEvent.at - latest.at <= REMOTE_ANALOG_LOG_COALESCE_MS
  ) {
    return [nextEvent, ...current.slice(1)];
  }

  return [nextEvent, ...current].slice(0, REMOTE_LOG_LIMIT);
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function volumePercentLabel(value: number): string {
  return `${Math.round(clampVolume(value) * 100)}%`;
}

interface GuestStreamTelemetry {
  bitrateKbps?: number;
  fps?: number;
  jitterMs?: number;
  rttMs?: number;
  bufferDelayMs?: number;
}

interface GuestInputRelayProfile {
  label: string;
  description: string;
  sendIntervalMs: number;
  idleHeartbeatMs: number;
  deltaThreshold: number;
}

interface OnlineSessionViewPreferences {
  guestFocusMode: boolean;
  showVirtualController: boolean;
  showGuestInputDeck: boolean;
  virtualControllerMode: 'full' | 'compact';
  virtualControllerCollapsed: boolean;
  guestInputRelayMode: GuestInputRelayMode;
  showGuestDiagnostics: boolean;
  autoQualityHintEnabled: boolean;
  autoStallRecoveryEnabled: boolean;
  guestQuickbarExpanded: boolean;
  guestPlayersCollapsed: boolean;
  guestChatCollapsed: boolean;
  hostPlayersCollapsed: boolean;
  hostControlsCollapsed: boolean;
  hostChatCollapsed: boolean;
  hostRemoteFeedCollapsed: boolean;
  hostQuickbarExpanded: boolean;
}

interface LatencySummary {
  averageMs: number;
  p95Ms: number;
}

interface LatencyTrendSummary {
  label: 'Stable' | 'Variable' | 'Spiky';
  className: string;
  spreadMs: number;
  bars: number[];
}

const HOST_STREAM_PRESET_LABELS: Record<HostStreamQualityPresetHint, string> = {
  ultra_low_latency: 'Ultra Low Latency',
  balanced: 'Balanced',
  quality: 'Quality',
};

const GUEST_INPUT_RELAY_PROFILES: Record<EffectiveGuestInputRelayMode, GuestInputRelayProfile> = {
  responsive: {
    label: 'Responsive',
    description: 'Lowest controller delay. Best on stronger Wi-Fi/Ethernet links.',
    sendIntervalMs: 16,
    idleHeartbeatMs: 72,
    deltaThreshold: 0.026,
  },
  balanced: {
    label: 'Balanced',
    description: 'Latency-first default with moderate network pressure.',
    sendIntervalMs: 24,
    idleHeartbeatMs: 110,
    deltaThreshold: 0.034,
  },
  conservative: {
    label: 'Conservative',
    description: 'Reduces network pressure on unstable links while keeping control cadence usable.',
    sendIntervalMs: 34,
    idleHeartbeatMs: 165,
    deltaThreshold: 0.05,
  },
};

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

const QUICK_CHAT_PRESETS = ['Ready?', 'Need 1 min', 'Re-sync please', 'Nice run!', 'GG'];
const VOICE_JOIN_TOOLTIP = 'If you want to join the conversation, click here to unmute yourself.';
const VOICE_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

function defaultOnlineSessionViewPreferences(): OnlineSessionViewPreferences {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return {
      guestFocusMode: false,
      showVirtualController: false,
      showGuestInputDeck: false,
      virtualControllerMode: 'compact',
      virtualControllerCollapsed: false,
      guestInputRelayMode: 'auto',
      showGuestDiagnostics: false,
      autoQualityHintEnabled: false,
      autoStallRecoveryEnabled: false,
      guestQuickbarExpanded: false,
      guestPlayersCollapsed: false,
      guestChatCollapsed: false,
      hostPlayersCollapsed: false,
      hostControlsCollapsed: true,
      hostChatCollapsed: true,
      hostRemoteFeedCollapsed: true,
      hostQuickbarExpanded: true,
    };
  }

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  const compactViewport = window.matchMedia('(max-width: 1200px)').matches;

  return {
    guestFocusMode: compactViewport,
    showVirtualController: coarsePointer,
    showGuestInputDeck: false,
    virtualControllerMode: coarsePointer ? 'full' : 'compact',
    virtualControllerCollapsed: false,
    guestInputRelayMode: 'auto',
    showGuestDiagnostics: false,
    autoQualityHintEnabled: false,
    autoStallRecoveryEnabled: false,
    guestQuickbarExpanded: false,
    guestPlayersCollapsed: compactViewport,
    guestChatCollapsed: compactViewport,
    hostPlayersCollapsed: false,
    hostControlsCollapsed: true,
    hostChatCollapsed: true,
    hostRemoteFeedCollapsed: true,
    hostQuickbarExpanded: false,
  };
}

function normalizeGuestInputRelayMode(value: unknown): GuestInputRelayMode {
  return value === 'responsive' || value === 'balanced' || value === 'conservative' || value === 'auto'
    ? value
    : 'auto';
}

function loadOnlineSessionViewPreferences(): OnlineSessionViewPreferences {
  const fallback = defaultOnlineSessionViewPreferences();
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const phoneViewport = window.matchMedia(`(max-width: ${ONLINE_PHONE_VIEWPORT_MAX_WIDTH}px)`).matches;
    const raw = window.localStorage.getItem(ONLINE_SESSION_VIEW_PREFS_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<OnlineSessionViewPreferences>;

    return {
      guestFocusMode:
        typeof parsed.guestFocusMode === 'boolean' ? parsed.guestFocusMode : fallback.guestFocusMode,
      showVirtualController:
        typeof parsed.showVirtualController === 'boolean'
          ? parsed.showVirtualController
          : fallback.showVirtualController,
      showGuestInputDeck:
        typeof parsed.showGuestInputDeck === 'boolean' ? parsed.showGuestInputDeck : fallback.showGuestInputDeck,
      virtualControllerMode:
        parsed.virtualControllerMode === 'full' || parsed.virtualControllerMode === 'compact'
          ? parsed.virtualControllerMode
          : fallback.virtualControllerMode,
      virtualControllerCollapsed:
        typeof parsed.virtualControllerCollapsed === 'boolean'
          ? parsed.virtualControllerCollapsed
          : fallback.virtualControllerCollapsed,
      guestInputRelayMode: normalizeGuestInputRelayMode(parsed.guestInputRelayMode),
      showGuestDiagnostics:
        typeof parsed.showGuestDiagnostics === 'boolean'
          ? parsed.showGuestDiagnostics
          : fallback.showGuestDiagnostics,
      // Keep recovery controls manual-first to avoid renegotiation loops/flicker.
      autoQualityHintEnabled: false,
      autoStallRecoveryEnabled: false,
      guestQuickbarExpanded:
        typeof parsed.guestQuickbarExpanded === 'boolean'
          ? phoneViewport && parsed.guestQuickbarExpanded
          : fallback.guestQuickbarExpanded,
      guestPlayersCollapsed:
        typeof parsed.guestPlayersCollapsed === 'boolean'
          ? parsed.guestPlayersCollapsed
          : fallback.guestPlayersCollapsed,
      guestChatCollapsed:
        typeof parsed.guestChatCollapsed === 'boolean' ? parsed.guestChatCollapsed : fallback.guestChatCollapsed,
      hostPlayersCollapsed:
        typeof parsed.hostPlayersCollapsed === 'boolean'
          ? parsed.hostPlayersCollapsed
          : fallback.hostPlayersCollapsed,
      hostControlsCollapsed:
        typeof parsed.hostControlsCollapsed === 'boolean'
          ? parsed.hostControlsCollapsed
          : fallback.hostControlsCollapsed,
      hostChatCollapsed:
        typeof parsed.hostChatCollapsed === 'boolean' ? parsed.hostChatCollapsed : fallback.hostChatCollapsed,
      hostRemoteFeedCollapsed:
        typeof parsed.hostRemoteFeedCollapsed === 'boolean'
          ? parsed.hostRemoteFeedCollapsed
          : fallback.hostRemoteFeedCollapsed,
      hostQuickbarExpanded:
        typeof parsed.hostQuickbarExpanded === 'boolean'
          ? phoneViewport && parsed.hostQuickbarExpanded
          : fallback.hostQuickbarExpanded,
    };
  } catch {
    return fallback;
  }
}

function saveAdvancedToolsPreference(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(ONLINE_ADVANCED_TOOLS_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore persistence failures while keeping runtime behavior intact.
  }
}

function summarizeLatency(history: number[]): LatencySummary | undefined {
  if (history.length === 0) {
    return undefined;
  }

  const sorted = [...history].sort((left, right) => left - right);
  const averageMs = Math.round(history.reduce((sum, sample) => sum + sample, 0) / history.length);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95Ms = sorted[p95Index];
  return { averageMs, p95Ms };
}

function summarizeLatencyTrend(history: number[]): LatencyTrendSummary | undefined {
  if (history.length < 3) {
    return undefined;
  }

  const samples = history.slice(-14);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const spreadMs = Math.max(0, Math.round(max - min));
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const stdDev = Math.sqrt(variance);
  const denominator = Math.max(1, max - min);
  const bars = samples.map((value) => {
    const normalized = (value - min) / denominator;
    return Math.round(24 + normalized * 76);
  });

  if (spreadMs <= 28 && stdDev <= 10) {
    return {
      label: 'Stable',
      className: 'status-pill status-good',
      spreadMs,
      bars,
    };
  }
  if (spreadMs <= 70 && stdDev <= 24) {
    return {
      label: 'Variable',
      className: 'status-pill status-warn',
      spreadMs,
      bars,
    };
  }
  return {
    label: 'Spiky',
    className: 'status-pill status-bad',
    spreadMs,
    bars,
  };
}

function sessionSnapshotSignature(session: MultiplayerSessionSnapshot): string {
  return JSON.stringify({
    code: session.code,
    romId: session.romId ?? null,
    romTitle: session.romTitle ?? null,
    joinLocked: Boolean(session.joinLocked),
    voiceEnabled: Boolean(session.voiceEnabled),
    members: session.members.map((member) => ({
      clientId: member.clientId,
      slot: member.slot,
      connected: member.connected,
      ready: member.ready,
      isHost: member.isHost,
      avatarUrl: member.avatarUrl ?? null,
      name: member.name,
    })),
    chatIds: session.chat.map((entry) => entry.id),
    mutedInputClientIds: [...(session.mutedInputClientIds ?? [])].sort(),
  });
}

function defaultQualityHintReason(
  requestedPreset: HostStreamQualityPresetHint,
  source: HostQualityHintRequestSource,
  networkHealthLabel: string,
): string {
  if (source === 'rescue') {
    return 'Latency rescue requested by guest to prioritize responsiveness.';
  }
  if (source === 'auto') {
    return requestedPreset === 'ultra_low_latency'
      ? `Auto request: guest network health is ${networkHealthLabel.toLowerCase()}; prefer lower stream latency.`
      : `Auto request: guest network health is ${networkHealthLabel.toLowerCase()}; balanced stream mode may reduce jitter.`;
  }

  if (requestedPreset === 'ultra_low_latency') {
    return 'Network health is poor for this viewer; prefer lower latency.';
  }
  if (requestedPreset === 'balanced') {
    return 'Stream latency is rising; balanced mode may stabilize controls.';
  }
  return 'Network is stable; quality mode should be safe if host prefers sharper visuals.';
}

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

function memberInitials(name: string): string {
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

function normalizeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().slice(0, 500);
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('data:image/')) {
    return normalized;
  }
  return undefined;
}

function SessionMemberAvatar({ member }: { member?: MultiplayerMember }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const avatarUrl = normalizeAvatarUrl(member?.avatarUrl);
  const showImage = Boolean(avatarUrl && failedUrl !== avatarUrl);

  return (
    <span className="session-member-avatar" aria-hidden="true">
      {showImage ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(avatarUrl ?? null)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span>{member ? memberInitials(member.name) : '?'}</span>
      )}
    </span>
  );
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

function readyClass(ready: boolean, connected: boolean): string {
  if (!connected) {
    return 'status-pill';
  }
  return ready ? 'status-pill status-good' : 'status-pill status-warn';
}

function relayPingClass(pingMs: number | undefined, connected: boolean): string {
  if (!connected || pingMs === undefined) {
    return 'status-pill';
  }
  if (pingMs <= 70) {
    return 'status-pill status-good';
  }
  if (pingMs <= 150) {
    return 'status-pill status-warn';
  }
  return 'status-pill status-bad';
}

function guestNetworkHealth(
  hostStreamStatus: HostStreamStatus,
  relayLatencyMs: number | undefined,
  streamRttMs: number | undefined,
  jitterMs: number | undefined,
): { label: string; className: string; recommendation: string } {
  if (hostStreamStatus === 'idle' || hostStreamStatus === 'connecting') {
    return {
      label: 'Connecting',
      className: 'status-pill status-warn',
      recommendation: 'Hold steady while the stream initializes.',
    };
  }
  if (hostStreamStatus === 'error') {
    return {
      label: 'Recovering',
      className: 'status-pill status-bad',
      recommendation: 'Use Re-sync Stream to force a fresh media negotiation.',
    };
  }

  const score =
    (relayLatencyMs ?? 0) * 0.45 +
    (streamRttMs ?? relayLatencyMs ?? 0) * 0.45 +
    (jitterMs ?? 0) * 2.8;

  if (score <= 95) {
    return {
      label: 'Excellent',
      className: 'status-pill status-good',
      recommendation: 'Current network path looks healthy for responsive play.',
    };
  }
  if (score <= 165) {
    return {
      label: 'Good',
      className: 'status-pill status-good',
      recommendation: 'Stable overall. Brief spikes should recover automatically.',
    };
  }
  if (score <= 260) {
    return {
      label: 'Fair',
      className: 'status-pill status-warn',
      recommendation: 'Minor delay detected. Keep Focus Mode on and avoid network-heavy background apps.',
    };
  }

  return {
    label: 'Poor',
    className: 'status-pill status-bad',
    recommendation: 'High delay detected. Use Re-sync Stream and ask host to prefer Ultra Low Latency mode.',
  };
}

function inboundVideoStats(report: RTCStats): RTCInboundRtpStreamStats | undefined {
  if (report.type !== 'inbound-rtp') {
    return undefined;
  }
  const inbound = report as RTCInboundRtpStreamStats & { mediaType?: string };
  const kind = inbound.kind ?? inbound.mediaType;
  return kind === 'video' ? inbound : undefined;
}

function normalizeSessionSnapshot(session: MultiplayerSessionSnapshot): MultiplayerSessionSnapshot {
  return {
    ...session,
    joinLocked: Boolean((session as { joinLocked?: unknown }).joinLocked),
    voiceEnabled: Boolean((session as { voiceEnabled?: unknown }).voiceEnabled),
    chat: Array.isArray((session as { chat?: unknown }).chat) ? session.chat : [],
    mutedInputClientIds: Array.isArray((session as { mutedInputClientIds?: unknown }).mutedInputClientIds)
      ? (session as { mutedInputClientIds: string[] }).mutedInputClientIds
      : [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function sendWebRtcSignal(
  socket: WebSocket | null,
  targetClientId: string,
  payload: { kind: 'offer' | 'answer'; sdp: string } | { kind: 'ice_candidate'; candidate: RTCIceCandidateInit },
): void {
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
}

export function OnlineSessionPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const roms = useAppStore((state) => state.roms);
  const loadingRoms = useAppStore((state) => state.loadingRoms);
  const refreshRoms = useAppStore((state) => state.refreshRoms);
  const profiles = useAppStore((state) => state.profiles);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const loadProfiles = useAppStore((state) => state.loadProfiles);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const setActiveProfile = useAppStore((state) => state.setActiveProfile);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const pendingPingSentAtRef = useRef<number | null>(null);
  const sessionClosedRef = useRef(false);
  const remotePressedStateRef = useRef<Partial<Record<N64DigitalTarget, boolean>>>({});
  const remoteAnalogStateRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const remoteAnalogLastSentAtRef = useRef<number>(0);
  const quickHoldControlsRef = useRef(new Set<N64ControlTarget>());
  const suppressQuickTapUntilRef = useRef<number>(0);
  const guestPeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const guestPendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const guestChatAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const guestVoiceLocalStreamRef = useRef<MediaStream | null>(null);
  const guestVoiceLocalTrackRef = useRef<MediaStreamTrack | null>(null);
  const guestVoiceSenderRef = useRef<RTCRtpSender | null>(null);
  const guestVideoReceiverRef = useRef<RTCRtpReceiver | null>(null);
  const guestStreamStatsBaselineRef = useRef<{ bytesReceived: number; measuredAtMs: number } | undefined>(undefined);
  const guestStreamBufferDelayMsRef = useRef<number>(0);
  const guestAutoResyncTimerRef = useRef<number | null>(null);
  const guestHardResyncTimerRef = useRef<number | null>(null);
  const guestBootstrapResyncTimerRef = useRef<number | null>(null);
  const guestBootstrapResyncAttemptedRomRef = useRef<string | null>(null);
  const guestBootstrapResyncLastRequestedAtRef = useRef<number>(0);
  const lastRoomStateSignatureRef = useRef<string>('');
  const lastGuestResyncRequestedAtRef = useRef<number>(0);
  const lastQualityHintRequestedAtRef = useRef<number>(0);
  const lastHostReadyCheckAtRef = useRef<number>(0);
  const autoQualityDegradedSinceRef = useRef<number | null>(null);
  const lastAutoQualityHintAtRef = useRef<number>(0);
  const lastAutoQualityHintPresetRef = useRef<HostStreamQualityPresetHint | null>(null);
  const lastLatencyRescueAtRef = useRef<number>(0);
  const guestLastPlaybackProgressAtRef = useRef<number>(0);
  const guestLastPlaybackTimeRef = useRef<number>(0);
  const guestLastPlaybackFramesRef = useRef<number>(0);
  const guestStreamLiveAtRef = useRef<number>(0);
  const lastGuestStallRecoveryAtRef = useRef<number>(0);
  const readyAutoLaunchTimerRef = useRef<number | null>(null);
  const hostStreamShellRef = useRef<HTMLDivElement | null>(null);
  const hostStreamVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestAutoDeckCollapsedForStreamRef = useRef(false);
  const hostPhoneDefaultsAppliedRef = useRef(false);
  const hostMissingRomNudgedRef = useRef(false);
  const guestPhoneDefaultsAppliedRef = useRef(false);
  const guestStreamPanelRef = useRef<HTMLElement | null>(null);
  const guestInputDeckRef = useRef<HTMLHeadingElement | null>(null);
  const quickProfileSwitchRef = useRef<HTMLDetailsElement | null>(null);
  const playersPanelRef = useRef<HTMLElement | null>(null);
  const hostControlsPanelRef = useRef<HTMLElement | null>(null);
  const chatPanelRef = useRef<HTMLElement | null>(null);
  const chatListRef = useRef<HTMLUListElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const remoteFeedListRef = useRef<HTMLUListElement | null>(null);
  const handleGuestWebRtcSignalRef = useRef<((message: WebRtcSignalMessage) => void) | null>(null);
  const scheduleRemoteInputFlushRef = useRef<((mode?: 'visible' | 'background') => void) | null>(null);
  const schedulePausedFeedCountFlushRef = useRef<(() => void) | null>(null);
  const bufferedRemoteInputsRef = useRef<RemoteInputEvent[]>([]);
  const pendingRemoteInputsRef = useRef<RemoteInputEvent[]>([]);
  const remoteInputFlushTimerRef = useRef<number | null>(null);
  const remoteInputFlushDelayRef = useRef<number | null>(null);
  const pausedFeedCountFlushTimerRef = useRef<number | null>(null);
  const hostRemoteFeedUiActiveRef = useRef(false);
  const hostRemoteFeedPausedRef = useRef(false);
  const captureRemoteInputDiagnosticsRef = useRef(false);
  const lastRemoteInputCountRef = useRef<number | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  const lastChatCountRef = useRef<number | null>(null);
  const initialViewPrefs = useMemo(() => loadOnlineSessionViewPreferences(), []);
  const [advancedSessionTools] = useState(false);
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [session, setSession] = useState<MultiplayerSessionSnapshot>();
  const [error, setError] = useState<string>();
  const [clipboardMessage, setClipboardMessage] = useState<string>();
  const [remoteInputs, setRemoteInputs] = useState<RemoteInputEvent[]>([]);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [latencyMs, setLatencyMs] = useState<number>();
  const [latencyHistory, setLatencyHistory] = useState<number[]>([]);
  const [sessionClosedReason, setSessionClosedReason] = useState<string>();
  const [endingSession, setEndingSession] = useState(false);
  const [kickingClientId, setKickingClientId] = useState<string>();
  const [movingSlotClientId, setMovingSlotClientId] = useState<string>();
  const [movingSlotTarget, setMovingSlotTarget] = useState<number>();
  const [mutingClientId, setMutingClientId] = useState<string>();
  const [hostRomSelectionId, setHostRomSelectionId] = useState(NO_ROOM_ROM);
  const [savingHostRomSelection, setSavingHostRomSelection] = useState(false);
  const [hostStreamStatus, setHostStreamStatus] = useState<HostStreamStatus>('idle');
  const hostStreamStatusRef = useRef<HostStreamStatus>('idle');
  const guestGameVolumeBeforeMuteRef = useRef(1);
  const guestChatVolumeBeforeMuteRef = useRef(1);
  const [lobbyAudioMuted, setLobbyAudioMuted] = useState(false);
  const [guestGameAudioVolume, setGuestGameAudioVolume] = useState(1);
  const [guestChatAudioVolume, setGuestChatAudioVolume] = useState(1);
  const [voiceInputMuted, setVoiceInputMuted] = useState(true);
  const [voiceMicRequesting, setVoiceMicRequesting] = useState(false);
  const [voiceMicError, setVoiceMicError] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>('create');
  const [wizardTemplateProfile, setWizardTemplateProfile] = useState<ControllerProfile>();
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [enforceReadyBeforeLaunch, setEnforceReadyBeforeLaunch] = useState(false);
  const [autoLaunchWhenReady, setAutoLaunchWhenReady] = useState(false);
  const [readyAutoLaunchCountdown, setReadyAutoLaunchCountdown] = useState<number | null>(null);
  const [guestFocusMode, setGuestFocusMode] = useState(() => initialViewPrefs.guestFocusMode);
  const [showVirtualController, setShowVirtualController] = useState(() => initialViewPrefs.showVirtualController);
  const [showGuestInputDeck, setShowGuestInputDeck] = useState(() => initialViewPrefs.showGuestInputDeck);
  const [virtualControllerMode, setVirtualControllerMode] = useState<'full' | 'compact'>(
    () => initialViewPrefs.virtualControllerMode,
  );
  const [virtualControllerCollapsed, setVirtualControllerCollapsed] = useState(
    () => initialViewPrefs.virtualControllerCollapsed,
  );
  const [guestInputRelayMode, setGuestInputRelayMode] = useState<GuestInputRelayMode>(() => initialViewPrefs.guestInputRelayMode);
  const [showGuestDiagnostics, setShowGuestDiagnostics] = useState(() => initialViewPrefs.showGuestDiagnostics);
  const [autoQualityHintEnabled, setAutoQualityHintEnabled] = useState(() => initialViewPrefs.autoQualityHintEnabled);
  const [autoStallRecoveryEnabled, setAutoStallRecoveryEnabled] = useState(() => initialViewPrefs.autoStallRecoveryEnabled);
  const [guestQuickbarExpanded, setGuestQuickbarExpanded] = useState(() => initialViewPrefs.guestQuickbarExpanded);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );
  const [coarsePointer, setCoarsePointer] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  });
  const [documentVisible, setDocumentVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );
  const [guestPlayersCollapsed, setGuestPlayersCollapsed] = useState(() => initialViewPrefs.guestPlayersCollapsed);
  const [guestChatCollapsed, setGuestChatCollapsed] = useState(() => initialViewPrefs.guestChatCollapsed);
  const [hostPlayersCollapsed, setHostPlayersCollapsed] = useState(() => initialViewPrefs.hostPlayersCollapsed);
  const [hostControlsCollapsed, setHostControlsCollapsed] = useState(() => initialViewPrefs.hostControlsCollapsed);
  const [hostChatCollapsed, setHostChatCollapsed] = useState(() => initialViewPrefs.hostChatCollapsed);
  const [hostRemoteFeedCollapsed, setHostRemoteFeedCollapsed] = useState(() => initialViewPrefs.hostRemoteFeedCollapsed);
  const [hostQuickbarExpanded, setHostQuickbarExpanded] = useState(() => initialViewPrefs.hostQuickbarExpanded);
  const [showHostLaunchOptions, setShowHostLaunchOptions] = useState(false);
  const [guestStreamTelemetry, setGuestStreamTelemetry] = useState<GuestStreamTelemetry>({});
  const [guestPlaybackState, setGuestPlaybackState] = useState<'starting' | 'live' | 'stalled' | 'recovering'>(
    'starting',
  );
  const [guestStreamAttached, setGuestStreamAttached] = useState(false);
  const [isGuestStreamFullscreen, setIsGuestStreamFullscreen] = useState(false);
  const [activeQuickHoldControls, setActiveQuickHoldControls] = useState<N64ControlTarget[]>([]);
  const [compactSessionDetailsExpanded, setCompactSessionDetailsExpanded] = useState(false);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [guestLastSeenChatCount, setGuestLastSeenChatCount] = useState(0);
  const [hostLastSeenChatCount, setHostLastSeenChatCount] = useState(0);
  const [hostLastSeenRemoteFeedCount, setHostLastSeenRemoteFeedCount] = useState(0);
  const [hostRemoteFeedPaused, setHostRemoteFeedPaused] = useState(false);
  const [hostRemoteFeedBufferedCount, setHostRemoteFeedBufferedCount] = useState(0);
  const [hostRemoteFeedFilterKind, setHostRemoteFeedFilterKind] = useState<HostRemoteFeedFilterKind>('all');
  const [hostRemoteFeedFilterSlot, setHostRemoteFeedFilterSlot] = useState<HostRemoteFeedSlotFilter>('all');
  const [hostRemoteFeedAutoFollow, setHostRemoteFeedAutoFollow] = useState(true);
  const [hostRemoteFeedDetachedCount, setHostRemoteFeedDetachedCount] = useState(0);
  const [chatAutoFollow, setChatAutoFollow] = useState(true);
  const [chatNewWhileDetached, setChatNewWhileDetached] = useState(0);
  const [sessionHeaderActionsExpanded, setSessionHeaderActionsExpanded] = useState(false);

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
  const sessionShareUrl =
    typeof window !== 'undefined' && sessionRoute ? `${window.location.origin}${sessionRoute}` : '';

  const currentMember = session?.members.find((member) => member.clientId === clientId);
  const isHost = currentMember?.isHost ?? false;
  const isHostRef = useRef(isHost);
  useEffect(() => {
    hostStreamStatusRef.current = hostStreamStatus;
  }, [hostStreamStatus]);
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);
  const activeProfile = useMemo<ControllerProfile | undefined>(
    () => profiles.find((profile) => profile.profileId === activeProfileId),
    [activeProfileId, profiles],
  );
  const activeProfileSummaryLabel = activeProfile?.name ?? 'None';

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
  const connectedReadyPlayers = useMemo(
    () => session?.members.filter((member) => member.connected && member.ready).length ?? 0,
    [session],
  );
  const everyoneConnectedReady = connectedPlayers > 0 && connectedReadyPlayers === connectedPlayers;
  const readyLaunchBlocked = enforceReadyBeforeLaunch && connectedPlayers > 1 && !everyoneConnectedReady;

  const inviteJoinUrl =
    typeof window === 'undefined' || normalizedCode.length === 0
      ? ''
      : buildInviteJoinUrl(normalizedCode, window.location.origin);
  const canSendRealtimeInput = socketStatus === 'connected' && !sessionClosedReason;
  const currentMemberReady = currentMember?.ready ?? false;
  const isCompactViewport = viewportWidth <= ONLINE_COMPACT_VIEWPORT_MAX_WIDTH;
  const isPhoneViewport = viewportWidth <= ONLINE_PHONE_VIEWPORT_MAX_WIDTH;
  const showGuestSecondaryPanels = isHost || !guestFocusMode;
  const roomJoinLocked = Boolean(session?.joinLocked);
  const mutedInputClientIds = useMemo(() => session?.mutedInputClientIds ?? [], [session?.mutedInputClientIds]);
  const mutedInputClientIdsSet = useMemo(() => new Set(mutedInputClientIds), [mutedInputClientIds]);
  const currentMemberInputMuted = currentMember ? mutedInputClientIdsSet.has(currentMember.clientId) : false;
  const canSendGuestControllerInput = canSendRealtimeInput && !currentMemberInputMuted;
  const selectedHostRom: RomRecord | undefined =
    hostRomSelectionId === NO_ROOM_ROM ? undefined : roms.find((rom) => rom.id === hostRomSelectionId);
  const autoLaunchRoute = session?.romId ? buildSessionPlayUrl(session.romId, sessionContext) : undefined;
  const autoLaunchEligible =
    isHost &&
    autoLaunchWhenReady &&
    Boolean(autoLaunchRoute) &&
    connectedPlayers > 1 &&
    everyoneConnectedReady &&
    !sessionClosedReason;
  const hostStreamStatusText =
    hostStreamStatus === 'live'
      ? 'Live host stream connected.'
      : hostStreamStatus === 'connecting'
        ? 'Connecting to host stream…'
        : hostStreamStatus === 'error'
        ? 'Host stream connection failed. Waiting for a new stream offer.'
        : session?.romId
          ? 'Host ROM is selected. Waiting for launch stream.'
          : 'No host ROM selected yet. Ask host to choose a room ROM.';
  const guestPlaybackStatus = useMemo(() => {
    if (hostStreamStatus === 'idle') {
      return {
        label: 'Idle',
        className: 'status-pill',
        detail: 'Waiting for host stream launch.',
      };
    }
    if (hostStreamStatus === 'connecting') {
      return {
        label: 'Starting',
        className: 'status-pill status-warn',
        detail: 'Negotiating media and buffering host stream.',
      };
    }
    if (hostStreamStatus === 'error') {
      return {
        label: 'Recovering',
        className: 'status-pill status-bad',
        detail: 'Playback pipeline dropped. Triggering reconnection path.',
      };
    }
    if (guestPlaybackState === 'recovering') {
      return {
        label: 'Recovering',
        className: 'status-pill status-warn',
        detail: 'Stream watchdog detected a freeze and requested recovery.',
      };
    }
    if (guestPlaybackState === 'stalled') {
      return {
        label: 'Stalled',
        className: 'status-pill status-bad',
        detail: autoStallRecoveryEnabled
          ? 'Playback appears frozen. Auto-recovery is armed.'
          : 'Playback appears frozen. Use Re-sync Stream to recover.',
      };
    }
    return {
      label: 'Live',
      className: 'status-pill status-good',
      detail: autoStallRecoveryEnabled
        ? 'Watchdog is monitoring playback and can auto-recover frozen video.'
        : 'Playback is live. Auto-recovery is disabled.',
    };
  }, [autoStallRecoveryEnabled, guestPlaybackState, hostStreamStatus]);
  const guestNetworkHealthStatus = useMemo(
    () => guestNetworkHealth(hostStreamStatus, latencyMs, guestStreamTelemetry.rttMs, guestStreamTelemetry.jitterMs),
    [guestStreamTelemetry.jitterMs, guestStreamTelemetry.rttMs, hostStreamStatus, latencyMs],
  );
  const suggestedHostPresetForGuest = useMemo<HostStreamQualityPresetHint>(() => {
    if (guestNetworkHealthStatus.label === 'Poor') {
      return 'ultra_low_latency';
    }
    if (guestNetworkHealthStatus.label === 'Fair') {
      return 'balanced';
    }
    return 'quality';
  }, [guestNetworkHealthStatus.label]);
  const hostGuestMembers = useMemo(
    () => (session?.members ?? []).filter((member) => !member.isHost),
    [session?.members],
  );
  const waitingGuestMembers = useMemo(
    () => hostGuestMembers.filter((member) => member.connected && !member.ready),
    [hostGuestMembers],
  );
  const connectedHostGuestCount = useMemo(
    () => hostGuestMembers.filter((member) => member.connected).length,
    [hostGuestMembers],
  );
  const mutedGuestCount = useMemo(
    () => hostGuestMembers.filter((member) => mutedInputClientIdsSet.has(member.clientId)).length,
    [hostGuestMembers, mutedInputClientIdsSet],
  );
  const hostRelayHealthSummary = useMemo(() => {
    const connectedGuests = hostGuestMembers.filter((member) => member.connected);
    if (connectedGuests.length === 0) {
      return {
        label: 'Waiting',
        className: 'status-pill',
        detail: 'No connected guests yet. Relay quality metrics appear after guests join.',
        averageMs: undefined as number | undefined,
        highLatencyCount: 0,
      };
    }

    const pingSamples = connectedGuests
      .map((member) => member.pingMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (pingSamples.length === 0) {
      return {
        label: 'Measuring',
        className: 'status-pill status-warn',
        detail: 'Connected guests are present. Collecting relay latency samples.',
        averageMs: undefined as number | undefined,
        highLatencyCount: 0,
      };
    }

    const averageMs = Math.round(pingSamples.reduce((sum, sample) => sum + sample, 0) / pingSamples.length);
    const highLatencyCount = pingSamples.filter((sample) => sample > 170).length;
    if (averageMs <= 85 && highLatencyCount === 0) {
      return {
        label: 'Healthy',
        className: 'status-pill status-good',
        detail: `Guest relay is responsive (avg ${averageMs}ms). Keep current stream mode.`,
        averageMs,
        highLatencyCount,
      };
    }
    if (averageMs <= 150 && highLatencyCount <= 1) {
      return {
        label: 'Mixed',
        className: 'status-pill status-warn',
        detail: `Relay is variable (avg ${averageMs}ms). Consider Balanced stream mode.`,
        averageMs,
        highLatencyCount,
      };
    }
    return {
      label: 'Strained',
      className: 'status-pill status-bad',
      detail: `Relay is high-latency (avg ${averageMs}ms, ${highLatencyCount} slow guest${highLatencyCount === 1 ? '' : 's'}).`,
      averageMs,
      highLatencyCount,
    };
  }, [hostGuestMembers]);
  const playersPanelCollapsed = isCompactViewport ? (isHost ? hostPlayersCollapsed : guestPlayersCollapsed) : false;
  const chatPanelCollapsed = isCompactViewport ? (isHost ? hostChatCollapsed : guestChatCollapsed) : false;
  const sessionChatCount = session?.chat.length ?? 0;
  const hostUnreadChatCount = Math.max(0, sessionChatCount - hostLastSeenChatCount);
  const guestUnreadChatCount = Math.max(0, sessionChatCount - guestLastSeenChatCount);
  const unreadChatCount = isHost ? hostUnreadChatCount : guestUnreadChatCount;
  const hostUnreadRemoteInputCount = Math.max(0, remoteInputs.length - hostLastSeenRemoteFeedCount);
  const filteredRemoteInputs = useMemo(
    () =>
      remoteInputs.filter((event) => {
        if (hostRemoteFeedFilterSlot !== 'all' && event.fromSlot !== hostRemoteFeedFilterSlot) {
          return false;
        }
        if (hostRemoteFeedFilterKind === 'all') {
          return true;
        }
        if (hostRemoteFeedFilterKind === 'analog') {
          return event.payload?.kind === 'analog';
        }
        if (hostRemoteFeedFilterKind === 'digital') {
          return event.payload?.kind === 'digital';
        }
        return !event.payload;
      }),
    [hostRemoteFeedFilterKind, hostRemoteFeedFilterSlot, remoteInputs],
  );
  const remoteFeedSummary = useMemo(() => {
    let analog = 0;
    let digital = 0;
    let unknown = 0;
    for (const event of filteredRemoteInputs) {
      if (event.payload?.kind === 'analog') {
        analog += 1;
      } else if (event.payload?.kind === 'digital') {
        digital += 1;
      } else {
        unknown += 1;
      }
    }
    return { analog, digital, unknown };
  }, [filteredRemoteInputs]);
  const hostOpenPanelCount =
    Number(!hostPlayersCollapsed) +
    Number(!hostControlsCollapsed) +
    Number(!hostChatCollapsed) +
    Number(!hostRemoteFeedCollapsed);
  const effectiveGuestInputRelayMode = useMemo<EffectiveGuestInputRelayMode>(() => {
    if (guestInputRelayMode !== 'auto') {
      return guestInputRelayMode;
    }
    if (guestNetworkHealthStatus.label === 'Poor') {
      return 'conservative';
    }
    if (guestNetworkHealthStatus.label === 'Fair') {
      return 'balanced';
    }
    if (guestNetworkHealthStatus.label === 'Excellent' || guestNetworkHealthStatus.label === 'Good') {
      return 'responsive';
    }
    return 'balanced';
  }, [guestInputRelayMode, guestNetworkHealthStatus.label]);
  const guestInputRelayProfile = useMemo(
    () => GUEST_INPUT_RELAY_PROFILES[effectiveGuestInputRelayMode],
    [effectiveGuestInputRelayMode],
  );
  const latencySummary = useMemo(() => summarizeLatency(latencyHistory), [latencyHistory]);
  const latencyTrendSummary = useMemo(() => summarizeLatencyTrend(latencyHistory), [latencyHistory]);
  const guestTwoColumnLayout =
    !isHost && showGuestSecondaryPanels && !guestFocusMode && viewportWidth >= 1180;
  const guestStreamPriorityMode = !isHost && guestFocusMode && !showGuestInputDeck;
  const showSessionDetails = !isPhoneViewport || compactSessionDetailsExpanded;
  const showDetailedSessionStatus = advancedSessionTools && compactSessionDetailsExpanded;
  const chatPanelVisible = showGuestSecondaryPanels && (!isCompactViewport || !chatPanelCollapsed);
  const compactSessionSummary = currentMember
    ? `${slotLabel(currentMember.slot)}${isHost ? ' host' : ''} • ${session?.romTitle ? 'ROM ready' : 'No ROM selected'}`
    : 'Assigning player slot…';
  const compactStatusSummary = `Players ${connectedPlayers}/4 • ${roomJoinLocked ? 'Room Locked' : 'Room Open'} • Ready ${connectedReadyPlayers}/${connectedPlayers || 1}`;
  const hostLaunchReady = Boolean(session?.romId) && !readyLaunchBlocked;
  const hostLaunchRoute = session?.romId ? buildSessionPlayUrl(session.romId, sessionContext) : undefined;
  const launchWaitingCount = Math.max(0, connectedPlayers - connectedReadyPlayers);
  const waitingGuestNamesLabel = useMemo(
    () => waitingGuestMembers.map((member) => member.name).join(', '),
    [waitingGuestMembers],
  );
  const hostLaunchBlockedReason = useMemo(() => {
    if (!session?.romId) {
      return 'Select a room ROM first.';
    }
    if (readyLaunchBlocked) {
      return `Ready lock is enabled. Waiting on ${launchWaitingCount} player${launchWaitingCount === 1 ? '' : 's'}.`;
    }
    if (socketStatus !== 'connected') {
      return 'Reconnect to launch in sync with guests.';
    }
    if (sessionClosedReason) {
      return 'Session is closed. Return to Online and create a new room.';
    }
    return '';
  }, [launchWaitingCount, readyLaunchBlocked, session?.romId, sessionClosedReason, socketStatus]);
  const chatDraftStorageKey =
    normalizedCode && clientId ? `online_chat_draft_v1:${normalizedCode}:${clientId}` : '';
  const showGuestRescueCard =
    !isHost && (guestNetworkHealthStatus.label === 'Poor' || guestPlaybackState === 'stalled' || hostStreamStatus === 'error');
  const showGuestDiagnosticsPanel = advancedSessionTools && showGuestDiagnostics;
  const guestQuickbarPinned = !isPhoneViewport || (guestFocusMode && !showGuestInputDeck);
  const hostQuickbarPinned = !isPhoneViewport || (hostControlsCollapsed && hostPlayersCollapsed && hostChatCollapsed);
  const hostRemoteFeedUiActive = isHost && !hostControlsCollapsed && !hostRemoteFeedCollapsed && !hostRemoteFeedPaused;
  const captureRemoteInputDiagnostics = isHost && advancedSessionTools;
  const runHostQuickAction = useCallback(
    (action: () => void | Promise<void>, options?: { keepExpanded?: boolean }): void => {
      void action();
      if (isPhoneViewport && !options?.keepExpanded) {
        setHostQuickbarExpanded(false);
      }
    },
    [isPhoneViewport],
  );
  const hostQuickActionHint = useMemo(() => {
    if (!isHost) {
      return '';
    }
    if (sessionClosedReason) {
      return 'Session ended. Return to Online to host a new room.';
    }
    if (socketStatus !== 'connected') {
      return 'Connection dropped. Use Reconnect to restore realtime controls.';
    }
    if (!session?.romId) {
      return 'Next step: pick a ROM in Host Controls, then press Launch Host ROM.';
    }
    if (connectedHostGuestCount === 0) {
      return 'Invite guests with your code/link. Multiplayer starts when someone joins.';
    }
    if (hostLaunchReady) {
      return 'Launch is ready. Start host ROM now for everyone.';
    }
    if (waitingGuestMembers.length > 0) {
      return `Waiting on ${waitingGuestMembers.length} guest${waitingGuestMembers.length === 1 ? '' : 's'}. Send a ready check ping.`;
    }
    if (enforceReadyBeforeLaunch && !everyoneConnectedReady) {
      return 'Ready check is pending. Use Ready Check to prompt guests.';
    }
    if (hostRemoteFeedPaused && hostRemoteFeedBufferedCount > 0) {
      return `Remote feed paused with ${hostRemoteFeedBufferedCount} buffered events. Resume feed to inspect latest input.`;
    }
    if (hostRelayHealthSummary.label === 'Strained') {
      return 'Relay is strained. Ask guests to use Turbo Latency or lower host stream quality.';
    }
    return 'Room is healthy. Launch host ROM when everyone is ready.';
  }, [
    connectedHostGuestCount,
    enforceReadyBeforeLaunch,
    everyoneConnectedReady,
    hostLaunchReady,
    hostRemoteFeedBufferedCount,
    hostRemoteFeedPaused,
    hostRelayHealthSummary.label,
    isHost,
    session?.romId,
    sessionClosedReason,
    socketStatus,
    waitingGuestMembers.length,
  ]);

  useEffect(() => {
    if (!isHost || !isPhoneViewport || !session) {
      hostMissingRomNudgedRef.current = false;
      return;
    }
    if (session.romId) {
      hostMissingRomNudgedRef.current = false;
      return;
    }
    if (hostMissingRomNudgedRef.current) {
      return;
    }
    hostMissingRomNudgedRef.current = true;
    setHostControlsCollapsed(false);
    setHostQuickbarExpanded(false);
  }, [isHost, isPhoneViewport, session]);

  useEffect(() => {
    if (advancedSessionTools) {
      return;
    }
    if (autoQualityHintEnabled) {
      setAutoQualityHintEnabled(false);
    }
    if (autoStallRecoveryEnabled) {
      setAutoStallRecoveryEnabled(false);
    }
  }, [advancedSessionTools, autoQualityHintEnabled, autoStallRecoveryEnabled]);

  useEffect(() => {
    if (isPhoneViewport) {
      return;
    }
    if (sessionHeaderActionsExpanded) {
      setSessionHeaderActionsExpanded(false);
    }
  }, [isPhoneViewport, sessionHeaderActionsExpanded]);
  const hostStreamPlaceholderTitle =
    hostStreamStatus === 'live'
      ? undefined
      : hostStreamStatus === 'connecting'
        ? guestStreamAttached
          ? undefined
          : 'Connecting stream'
        : hostStreamStatus === 'error'
          ? 'Stream dropped'
          : 'Waiting for host stream';
  const hostStreamPlaceholderHint =
    hostStreamStatus === 'connecting'
      ? guestStreamAttached
        ? ''
        : 'Negotiating video with host.'
      : hostStreamStatus === 'error'
        ? 'Try Re-sync Stream if playback does not recover.'
        : !session?.romId
          ? 'Host needs to choose a room ROM first, then launch from gameplay view.'
          : 'Host needs to launch the selected ROM from gameplay view.';

  const setClipboardFeedback = useCallback((message: string): void => {
    setClipboardMessage(message);
    if (clipboardTimerRef.current !== null) {
      window.clearTimeout(clipboardTimerRef.current);
    }
    clipboardTimerRef.current = window.setTimeout(() => {
      setClipboardMessage((current) => (current === message ? undefined : current));
    }, 2_000);
  }, []);

  const applySessionSnapshotIfChanged = useCallback((nextSession: MultiplayerSessionSnapshot): void => {
    const signature = sessionSnapshotSignature(nextSession);
    if (lastRoomStateSignatureRef.current === signature) {
      return;
    }
    lastRoomStateSignatureRef.current = signature;
    setSession(nextSession);
  }, []);

  const setGuestStreamTelemetryIfChanged = useCallback((next: GuestStreamTelemetry): void => {
    const normalizeMetric = (value: number | undefined, step: number): number | undefined => {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return undefined;
      }
      return Math.round(value / step) * step;
    };
    const normalizedNext: GuestStreamTelemetry = {
      bitrateKbps: normalizeMetric(next.bitrateKbps, 60),
      fps: normalizeMetric(next.fps, 1),
      jitterMs: normalizeMetric(next.jitterMs, 4),
      rttMs: normalizeMetric(next.rttMs, 4),
      bufferDelayMs: normalizeMetric(next.bufferDelayMs, 8),
    };
    setGuestStreamTelemetry((current) => {
      if (
        current.bitrateKbps === normalizedNext.bitrateKbps &&
        current.fps === normalizedNext.fps &&
        current.jitterMs === normalizedNext.jitterMs &&
        current.rttMs === normalizedNext.rttMs &&
        current.bufferDelayMs === normalizedNext.bufferDelayMs
      ) {
        return current;
      }
      return normalizedNext;
    });
  }, []);

  const flushPendingRemoteInputs = useCallback((): void => {
    if (pendingRemoteInputsRef.current.length === 0) {
      return;
    }
    const queued = [...pendingRemoteInputsRef.current];
    pendingRemoteInputsRef.current = [];
    setRemoteInputs((current) => {
      let next = current;
      for (const event of queued) {
        next = appendRemoteInputEvent(next, event);
      }
      return next;
    });
  }, []);

  const scheduleRemoteInputFlush = useCallback((mode: 'visible' | 'background' = 'visible'): void => {
    const requestedDelay =
      mode === 'visible' ? REMOTE_FEED_UI_FLUSH_MS_VISIBLE : REMOTE_FEED_UI_FLUSH_MS_BACKGROUND;
    if (remoteInputFlushTimerRef.current !== null) {
      if (
        remoteInputFlushDelayRef.current !== null &&
        requestedDelay < remoteInputFlushDelayRef.current
      ) {
        window.clearTimeout(remoteInputFlushTimerRef.current);
        remoteInputFlushTimerRef.current = null;
      } else {
        return;
      }
    }

    remoteInputFlushDelayRef.current = requestedDelay;
    remoteInputFlushTimerRef.current = window.setTimeout(() => {
      remoteInputFlushTimerRef.current = null;
      remoteInputFlushDelayRef.current = null;
      flushPendingRemoteInputs();
    }, requestedDelay);
  }, [flushPendingRemoteInputs]);

  const schedulePausedFeedCountFlush = useCallback((): void => {
    if (pausedFeedCountFlushTimerRef.current !== null) {
      return;
    }
    pausedFeedCountFlushTimerRef.current = window.setTimeout(() => {
      pausedFeedCountFlushTimerRef.current = null;
      setHostRemoteFeedBufferedCount(bufferedRemoteInputsRef.current.length);
    }, REMOTE_FEED_PAUSED_COUNT_FLUSH_MS);
  }, []);

  useEffect(() => {
    scheduleRemoteInputFlushRef.current = scheduleRemoteInputFlush;
  }, [scheduleRemoteInputFlush]);

  useEffect(() => {
    schedulePausedFeedCountFlushRef.current = schedulePausedFeedCountFlush;
  }, [schedulePausedFeedCountFlush]);

  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current !== null) {
        window.clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = null;
      }
    };
  }, []);

  const refreshSessionSnapshot = useCallback(async (source: 'manual' | 'poll' = 'manual'): Promise<boolean> => {
    if (!normalizedCode) {
      return false;
    }
    if (source === 'manual') {
      setRefreshingSnapshot(true);
    }

    try {
      const snapshot = await getOnlineSession(normalizedCode);
      applySessionSnapshotIfChanged(normalizeSessionSnapshot(snapshot.session));
      if (source === 'manual') {
        setClipboardFeedback('Session refreshed.');
      }
      return true;
    } catch (loadError) {
      if (source === 'manual') {
        const message = loadError instanceof Error ? loadError.message : 'Failed to refresh session.';
        setError(message);
      }
      return false;
    } finally {
      if (source === 'manual') {
        setRefreshingSnapshot(false);
      }
    }
  }, [applySessionSnapshotIfChanged, normalizedCode, setClipboardFeedback]);

  useEffect(() => {
    lastRoomStateSignatureRef.current = '';
  }, [clientId, normalizedCode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const serialized = JSON.stringify({
        guestFocusMode,
        showVirtualController,
        showGuestInputDeck,
        virtualControllerMode,
        virtualControllerCollapsed,
        guestInputRelayMode,
        showGuestDiagnostics,
        autoQualityHintEnabled,
        autoStallRecoveryEnabled,
        guestQuickbarExpanded,
        guestPlayersCollapsed,
        guestChatCollapsed,
        hostPlayersCollapsed,
        hostControlsCollapsed,
        hostChatCollapsed,
        hostRemoteFeedCollapsed,
        hostQuickbarExpanded,
      } satisfies OnlineSessionViewPreferences);
      window.localStorage.setItem(ONLINE_SESSION_VIEW_PREFS_KEY, serialized);
    } catch {
      // Preference persistence is best-effort only.
    }
  }, [
    autoQualityHintEnabled,
    autoStallRecoveryEnabled,
    guestChatCollapsed,
    guestFocusMode,
    guestInputRelayMode,
    guestQuickbarExpanded,
    guestPlayersCollapsed,
    hostChatCollapsed,
    hostControlsCollapsed,
    hostPlayersCollapsed,
    hostRemoteFeedCollapsed,
    hostQuickbarExpanded,
    showGuestDiagnostics,
    showGuestInputDeck,
    showVirtualController,
    virtualControllerCollapsed,
    virtualControllerMode,
  ]);

  useEffect(() => {
    saveAdvancedToolsPreference(advancedSessionTools);
  }, [advancedSessionTools]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const pointerQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    const updateViewport = (): void => {
      setViewportWidth(window.innerWidth);
    };
    const updatePointer = (): void => {
      setCoarsePointer(pointerQuery.matches);
    };

    updateViewport();
    updatePointer();
    window.addEventListener('resize', updateViewport);
    if (typeof pointerQuery.addEventListener === 'function') {
      pointerQuery.addEventListener('change', updatePointer);
      return () => {
        window.removeEventListener('resize', updateViewport);
        pointerQuery.removeEventListener('change', updatePointer);
      };
    }

    pointerQuery.addListener(updatePointer);
    return () => {
      window.removeEventListener('resize', updateViewport);
      pointerQuery.removeListener(updatePointer);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const onVisibilityChange = (): void => {
      setDocumentVisible(document.visibilityState === 'visible');
    };

    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!showVirtualController && virtualControllerCollapsed) {
      setVirtualControllerCollapsed(false);
    }
  }, [showVirtualController, virtualControllerCollapsed]);

  useEffect(() => {
    if (!isHost || !isPhoneViewport || hostPhoneDefaultsAppliedRef.current) {
      return;
    }
    hostPhoneDefaultsAppliedRef.current = true;
    setHostPlayersCollapsed(true);
    setHostControlsCollapsed(true);
    setHostChatCollapsed(true);
    setHostRemoteFeedCollapsed(true);
  }, [isHost, isPhoneViewport]);

  useEffect(() => {
    if (!isHost || !isPhoneViewport) {
      hostPhoneDefaultsAppliedRef.current = false;
    }
  }, [isHost, isPhoneViewport]);

  useEffect(() => {
    if (!isPhoneViewport && hostQuickbarExpanded) {
      setHostQuickbarExpanded(false);
    }
  }, [hostQuickbarExpanded, isPhoneViewport]);

  useEffect(() => {
    if (!isPhoneViewport && compactSessionDetailsExpanded) {
      setCompactSessionDetailsExpanded(false);
    }
  }, [compactSessionDetailsExpanded, isPhoneViewport]);

  useEffect(() => {
    if (isPhoneViewport) {
      return;
    }
    setGuestQuickbarExpanded(false);
    setHostQuickbarExpanded(false);
  }, [isPhoneViewport]);

  useEffect(() => {
    setGuestLastSeenChatCount((count) => Math.min(count, sessionChatCount));
    setHostLastSeenChatCount((count) => Math.min(count, sessionChatCount));
  }, [sessionChatCount]);

  useEffect(() => {
    setHostLastSeenRemoteFeedCount((count) => Math.min(count, remoteInputs.length));
  }, [remoteInputs.length]);

  useEffect(() => {
    hostRemoteFeedPausedRef.current = hostRemoteFeedPaused;
  }, [hostRemoteFeedPaused]);

  useEffect(() => {
    hostRemoteFeedUiActiveRef.current = hostRemoteFeedUiActive;
  }, [hostRemoteFeedUiActive]);

  useEffect(() => {
    captureRemoteInputDiagnosticsRef.current = captureRemoteInputDiagnostics;
  }, [captureRemoteInputDiagnostics]);

  useEffect(() => {
    if (captureRemoteInputDiagnostics) {
      return;
    }
    pendingRemoteInputsRef.current = [];
    bufferedRemoteInputsRef.current = [];
    setRemoteInputs((current) => (current.length === 0 ? current : []));
    setHostRemoteFeedBufferedCount((count) => (count === 0 ? count : 0));
    setHostRemoteFeedDetachedCount((count) => (count === 0 ? count : 0));
    setHostLastSeenRemoteFeedCount((count) => (count === 0 ? count : 0));
  }, [captureRemoteInputDiagnostics]);

  useEffect(() => {
    if (isHost) {
      return;
    }
    if (!showGuestSecondaryPanels || (isCompactViewport && guestChatCollapsed)) {
      return;
    }
    setGuestLastSeenChatCount(sessionChatCount);
  }, [guestChatCollapsed, isCompactViewport, isHost, sessionChatCount, showGuestSecondaryPanels]);

  useEffect(() => {
    if (!isHost) {
      return;
    }
    if (isCompactViewport && hostChatCollapsed) {
      return;
    }
    setHostLastSeenChatCount(sessionChatCount);
  }, [hostChatCollapsed, isCompactViewport, isHost, sessionChatCount]);

  useEffect(() => {
    if (!isHost) {
      return;
    }
    if (hostControlsCollapsed || hostRemoteFeedCollapsed) {
      return;
    }
    setHostLastSeenRemoteFeedCount(remoteInputs.length);
  }, [hostControlsCollapsed, hostRemoteFeedCollapsed, isHost, remoteInputs.length]);

  useEffect(() => {
    if (!isHost) {
      return;
    }
    if (lastRemoteInputCountRef.current === null) {
      lastRemoteInputCountRef.current = remoteInputs.length;
      return;
    }

    const previous = lastRemoteInputCountRef.current;
    if (remoteInputs.length < previous) {
      lastRemoteInputCountRef.current = remoteInputs.length;
      setHostRemoteFeedDetachedCount(0);
      return;
    }

    const delta = remoteInputs.length - previous;
    if (delta <= 0) {
      return;
    }
    lastRemoteInputCountRef.current = remoteInputs.length;

    if (hostControlsCollapsed || hostRemoteFeedCollapsed || !hostRemoteFeedAutoFollow) {
      setHostRemoteFeedDetachedCount((current) => current + delta);
      return;
    }

    setHostRemoteFeedDetachedCount(0);
    window.requestAnimationFrame(() => {
      const list = remoteFeedListRef.current;
      if (!list) {
        return;
      }
      list.scrollTop = list.scrollHeight;
    });
  }, [
    hostControlsCollapsed,
    hostRemoteFeedAutoFollow,
    hostRemoteFeedCollapsed,
    isHost,
    remoteInputs.length,
  ]);

  useEffect(() => {
    if (!isHost || hostRemoteFeedPaused || bufferedRemoteInputsRef.current.length === 0) {
      return;
    }

    const buffered = [...bufferedRemoteInputsRef.current];
    bufferedRemoteInputsRef.current = [];
    setHostRemoteFeedBufferedCount(0);
    setRemoteInputs((current) => {
      let next = current;
      for (const event of buffered) {
        next = appendRemoteInputEvent(next, event);
      }
      return next;
    });
    setClipboardFeedback(`Applied ${buffered.length} buffered input event${buffered.length === 1 ? '' : 's'}.`);
  }, [hostRemoteFeedPaused, isHost, setClipboardFeedback]);

  useEffect(() => {
    if (!chatDraftStorageKey || typeof window === 'undefined') {
      return;
    }
    try {
      const saved = window.localStorage.getItem(chatDraftStorageKey);
      if (saved) {
        const normalized = saved.slice(0, CHAT_MAX_LENGTH);
        setChatDraft((current) => (current ? current : normalized));
      }
    } catch {
      // Draft restore is best-effort only.
    }
  }, [chatDraftStorageKey]);

  useEffect(() => {
    if (!chatDraftStorageKey || typeof window === 'undefined') {
      return;
    }
    try {
      if (!chatDraft.trim()) {
        window.localStorage.removeItem(chatDraftStorageKey);
      } else {
        window.localStorage.setItem(chatDraftStorageKey, chatDraft.slice(0, CHAT_MAX_LENGTH));
      }
    } catch {
      // Draft persistence is best-effort only.
    }
  }, [chatDraft, chatDraftStorageKey]);

  useEffect(() => {
    if (lastChatCountRef.current === null) {
      lastChatCountRef.current = sessionChatCount;
      if (chatPanelVisible && chatAutoFollow && chatListRef.current) {
        chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
      }
      return;
    }

    const previous = lastChatCountRef.current;
    if (sessionChatCount < previous) {
      lastChatCountRef.current = sessionChatCount;
      setChatNewWhileDetached(0);
      return;
    }

    const delta = sessionChatCount - previous;
    if (delta <= 0) {
      return;
    }
    lastChatCountRef.current = sessionChatCount;

    if (!chatPanelVisible || !chatAutoFollow) {
      setChatNewWhileDetached((current) => current + delta);
      return;
    }

    setChatNewWhileDetached(0);
    window.requestAnimationFrame(() => {
      const list = chatListRef.current;
      if (!list) {
        return;
      }
      list.scrollTop = list.scrollHeight;
    });
  }, [chatAutoFollow, chatPanelVisible, sessionChatCount]);

  useEffect(() => {
    if (isHost || !isPhoneViewport || guestPhoneDefaultsAppliedRef.current) {
      return;
    }
    guestPhoneDefaultsAppliedRef.current = true;
    setVirtualControllerMode('compact');
    setGuestFocusMode(true);
    setShowGuestDiagnostics(false);
    setGuestPlayersCollapsed(true);
    setGuestChatCollapsed(true);
  }, [isHost, isPhoneViewport]);

  useEffect(() => {
    if (isHost || !isPhoneViewport) {
      guestPhoneDefaultsAppliedRef.current = false;
    }
  }, [isHost, isPhoneViewport]);

  useEffect(() => {
    if (isHost) {
      return;
    }
    pendingRemoteInputsRef.current = [];
    if (remoteInputFlushTimerRef.current !== null) {
      window.clearTimeout(remoteInputFlushTimerRef.current);
      remoteInputFlushTimerRef.current = null;
    }
    remoteInputFlushDelayRef.current = null;
    if (pausedFeedCountFlushTimerRef.current !== null) {
      window.clearTimeout(pausedFeedCountFlushTimerRef.current);
      pausedFeedCountFlushTimerRef.current = null;
    }
    bufferedRemoteInputsRef.current = [];
    setHostRemoteFeedPaused(false);
    setHostRemoteFeedBufferedCount(0);
    setHostRemoteFeedDetachedCount(0);
  }, [isHost]);

  useEffect(() => {
    return () => {
      if (remoteInputFlushTimerRef.current !== null) {
        window.clearTimeout(remoteInputFlushTimerRef.current);
        remoteInputFlushTimerRef.current = null;
      }
      remoteInputFlushDelayRef.current = null;
      if (pausedFeedCountFlushTimerRef.current !== null) {
        window.clearTimeout(pausedFeedCountFlushTimerRef.current);
        pausedFeedCountFlushTimerRef.current = null;
      }
      pendingRemoteInputsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (isHost || !coarsePointer) {
      guestAutoDeckCollapsedForStreamRef.current = false;
      return;
    }

    if (hostStreamStatus !== 'live' || guestAutoDeckCollapsedForStreamRef.current || !showGuestInputDeck) {
      return;
    }

    setShowGuestInputDeck(false);
    guestAutoDeckCollapsedForStreamRef.current = true;
    setClipboardFeedback('Input deck auto-hidden for stream focus. Tap "Show Input Deck" any time.');
  }, [coarsePointer, hostStreamStatus, isHost, setClipboardFeedback, showGuestInputDeck]);

  const clearReadyAutoLaunchTimer = useCallback((): void => {
    if (readyAutoLaunchTimerRef.current !== null) {
      window.clearTimeout(readyAutoLaunchTimerRef.current);
      readyAutoLaunchTimerRef.current = null;
    }
  }, []);

  const clearGuestAutoResyncTimer = useCallback((): void => {
    if (guestAutoResyncTimerRef.current !== null) {
      window.clearTimeout(guestAutoResyncTimerRef.current);
      guestAutoResyncTimerRef.current = null;
    }
  }, []);

  const clearGuestHardResyncTimer = useCallback((): void => {
    if (guestHardResyncTimerRef.current !== null) {
      window.clearTimeout(guestHardResyncTimerRef.current);
      guestHardResyncTimerRef.current = null;
    }
  }, []);

  const clearGuestBootstrapResyncTimer = useCallback((): void => {
    if (guestBootstrapResyncTimerRef.current !== null) {
      window.clearTimeout(guestBootstrapResyncTimerRef.current);
      guestBootstrapResyncTimerRef.current = null;
    }
  }, []);

  const applyGuestVideoReceiverLatencyHint = useCallback((
    receiver: RTCRtpReceiver | null,
    mode: 'default' | 'recovery' = 'default',
  ): void => {
    if (!receiver) {
      return;
    }

    try {
      receiver.jitterBufferTarget =
        mode === 'recovery' ? GUEST_VIDEO_JITTER_TARGET_RECOVERY_MS : GUEST_VIDEO_JITTER_TARGET_DEFAULT_MS;
    } catch {
      // Ignore unsupported jitterBufferTarget tuning on older browsers.
    }
  }, []);

  const tuneGuestVideoElementForLowLatency = useCallback((video: HTMLVideoElement): void => {
    video.defaultPlaybackRate = 1;
    video.playbackRate = 1;
    video.preload = 'none';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.setAttribute('disableRemotePlayback', 'true');
  }, []);

  const clearGuestChatAudioPlayback = useCallback((): void => {
    for (const element of guestChatAudioElementsRef.current.values()) {
      element.pause();
      element.srcObject = null;
    }
    guestChatAudioElementsRef.current.clear();
  }, []);

  const applyGuestChatAudioVolume = useCallback((volume: number): void => {
    const normalized = clampVolume(volume);
    for (const element of guestChatAudioElementsRef.current.values()) {
      element.volume = normalized;
    }
  }, []);

  const attachGuestChatAudioTrack = useCallback((track: MediaStreamTrack): void => {
    const stream = new MediaStream([track]);
    let element = guestChatAudioElementsRef.current.get(track.id);
    if (!element) {
      element = document.createElement('audio');
      element.autoplay = true;
      guestChatAudioElementsRef.current.set(track.id, element);
    }
    element.srcObject = stream;
    element.volume = clampVolume(guestChatAudioVolume);
    void element.play().catch(() => {
      // Autoplay can be blocked until the user interacts with the page.
    });

    track.onended = () => {
      const existing = guestChatAudioElementsRef.current.get(track.id);
      if (!existing) {
        return;
      }
      existing.pause();
      existing.srcObject = null;
      guestChatAudioElementsRef.current.delete(track.id);
    };
  }, [guestChatAudioVolume]);

  const clearGuestPeerConnection = useCallback((): void => {
    clearGuestAutoResyncTimer();
    clearGuestHardResyncTimer();
    clearGuestBootstrapResyncTimer();
    clearGuestChatAudioPlayback();

    const peer = guestPeerConnectionRef.current;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
      guestPeerConnectionRef.current = null;
    }
    guestVoiceSenderRef.current = null;
    guestVideoReceiverRef.current = null;

    guestPendingIceCandidatesRef.current = [];
    guestStreamStatsBaselineRef.current = undefined;
    guestStreamBufferDelayMsRef.current = 0;
    guestLastPlaybackProgressAtRef.current = 0;
    guestLastPlaybackTimeRef.current = 0;
    guestLastPlaybackFramesRef.current = 0;
    guestStreamLiveAtRef.current = 0;
    lastGuestStallRecoveryAtRef.current = 0;
    setGuestStreamTelemetryIfChanged({});
    setGuestPlaybackState('starting');
    setGuestStreamAttached(false);

    const video = hostStreamVideoRef.current;
    if (video) {
      video.onloadeddata = null;
      video.onplaying = null;
      video.onwaiting = null;
      video.onstalled = null;
      video.onerror = null;
      video.playbackRate = 1;
      video.defaultPlaybackRate = 1;
      video.srcObject = null;
    }
  }, [
    clearGuestAutoResyncTimer,
    clearGuestBootstrapResyncTimer,
    clearGuestChatAudioPlayback,
    clearGuestHardResyncTimer,
    setGuestStreamTelemetryIfChanged,
  ]);

  const stopGuestVoiceCapture = useCallback((): void => {
    const stream = guestVoiceLocalStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }
    guestVoiceLocalStreamRef.current = null;
    guestVoiceLocalTrackRef.current = null;
    guestVoiceSenderRef.current = null;
    setVoiceMicRequesting(false);
  }, []);

  const ensureGuestVoiceCapture = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const currentTrack = guestVoiceLocalTrackRef.current;
    if (currentTrack && currentTrack.readyState === 'live') {
      return currentTrack;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setVoiceMicError('Microphone capture is unavailable in this browser.');
      return null;
    }

    setVoiceMicRequesting(true);
    setVoiceMicError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(VOICE_MEDIA_CONSTRAINTS);
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((candidate) => candidate.stop());
        throw new Error('No microphone track was detected.');
      }
      const previousStream = guestVoiceLocalStreamRef.current;
      if (previousStream && previousStream !== stream) {
        previousStream.getTracks().forEach((candidate) => candidate.stop());
      }
      guestVoiceLocalStreamRef.current = stream;
      guestVoiceLocalTrackRef.current = track;
      return track;
    } catch (captureError) {
      const message =
        captureError instanceof Error && captureError.message.trim().length > 0
          ? captureError.message
          : 'Microphone permission was denied.';
      setVoiceMicError(message);
      return null;
    } finally {
      setVoiceMicRequesting(false);
    }
  }, []);

  const requestGuestStreamResync = useCallback(
    (
      reason: 'manual' | 'auto',
      options?: { silent?: boolean; hardReset?: boolean; bypassCooldown?: boolean },
    ): boolean => {
      const silent = Boolean(options?.silent);
      const hardReset = Boolean(options?.hardReset);
      const bypassCooldown = Boolean(options?.bypassCooldown);
      if (isHost) {
        return false;
      }

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reason === 'manual' && !silent) {
          setClipboardFeedback('Connect before requesting stream resync.');
        }
        return false;
      }

      const now = Date.now();
      if (!bypassCooldown && now - lastGuestResyncRequestedAtRef.current < GUEST_RESYNC_REQUEST_COOLDOWN_MS) {
        if (reason === 'manual' && !silent) {
          setClipboardFeedback('Resync is cooling down. Try again in a moment.');
        }
        return false;
      }

      lastGuestResyncRequestedAtRef.current = now;
      clearGuestAutoResyncTimer();
      clearGuestBootstrapResyncTimer();
      clearGuestHardResyncTimer();

      if (hardReset) {
        clearGuestPeerConnection();
        setHostStreamStatus('connecting');
        setGuestPlaybackState('starting');
      } else {
        applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'recovery');
        setHostStreamStatus((current) => (current === 'live' ? current : 'connecting'));
        setGuestPlaybackState((current) => (current === 'starting' ? current : 'recovering'));
      }

      socket.send(
        JSON.stringify({
          type: 'stream_resync_request',
        }),
      );

      if (!silent) {
        setClipboardFeedback(
          reason === 'manual' ? 'Requested host stream resync.' : 'Auto-recovery requested stream resync.',
        );
      }
      return true;
    },
    [
      applyGuestVideoReceiverLatencyHint,
      clearGuestAutoResyncTimer,
      clearGuestBootstrapResyncTimer,
      clearGuestHardResyncTimer,
      clearGuestPeerConnection,
      isHost,
      setClipboardFeedback,
    ],
  );

  const scheduleGuestAutoResync = useCallback((): void => {
    if (isHost || !autoStallRecoveryEnabled || hostStreamStatus === 'idle' || hostStreamStatus === 'error') {
      return;
    }
    if (guestAutoResyncTimerRef.current !== null) {
      return;
    }

    guestAutoResyncTimerRef.current = window.setTimeout(() => {
      guestAutoResyncTimerRef.current = null;
      setGuestPlaybackState('recovering');
      requestGuestStreamResync('auto');
    }, GUEST_AUTO_RESYNC_AFTER_STALL_MS);
  }, [autoStallRecoveryEnabled, hostStreamStatus, isHost, requestGuestStreamResync]);

  const wireGuestVideoStatusHandlers = useCallback((video: HTMLVideoElement): void => {
    tuneGuestVideoElementForLowLatency(video);
    video.onloadeddata = () => {
      clearGuestAutoResyncTimer();
      clearGuestHardResyncTimer();
      applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'default');
      guestStreamLiveAtRef.current = performance.now();
      guestLastPlaybackProgressAtRef.current = performance.now();
      guestLastPlaybackTimeRef.current = video.currentTime;
      guestLastPlaybackFramesRef.current =
        typeof video.getVideoPlaybackQuality === 'function'
          ? video.getVideoPlaybackQuality().totalVideoFrames
          : 0;
      setHostStreamStatus('live');
      setGuestPlaybackState('live');
    };
    video.onplaying = () => {
      clearGuestAutoResyncTimer();
      clearGuestHardResyncTimer();
      applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'default');
      video.playbackRate = 1;
      guestStreamLiveAtRef.current = performance.now();
      guestLastPlaybackProgressAtRef.current = performance.now();
      guestLastPlaybackTimeRef.current = video.currentTime;
      guestLastPlaybackFramesRef.current =
        typeof video.getVideoPlaybackQuality === 'function'
          ? video.getVideoPlaybackQuality().totalVideoFrames
          : 0;
      setHostStreamStatus('live');
      setGuestPlaybackState('live');
    };
    video.onwaiting = () => {
      applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'recovery');
      setGuestPlaybackState('stalled');
    };
    video.onstalled = () => {
      applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'recovery');
      setGuestPlaybackState('stalled');
    };
    video.onerror = () => {
      applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'recovery');
      setHostStreamStatus('error');
      setGuestPlaybackState('recovering');
    };
  }, [
    applyGuestVideoReceiverLatencyHint,
    clearGuestAutoResyncTimer,
    clearGuestHardResyncTimer,
    tuneGuestVideoElementForLowLatency,
  ]);

  const ensureGuestPeerConnection = useCallback((hostClientId: string): RTCPeerConnection => {
    const existing = guestPeerConnectionRef.current;
    if (existing) {
      if (
        !guestVoiceSenderRef.current &&
        guestVoiceLocalTrackRef.current &&
        guestVoiceLocalStreamRef.current &&
        Boolean(session?.voiceEnabled) &&
        !voiceInputMuted
      ) {
        guestVoiceSenderRef.current = existing.addTrack(guestVoiceLocalTrackRef.current, guestVoiceLocalStreamRef.current);
      }
      return existing;
    }

    const connection = new RTCPeerConnection(WEBRTC_CONFIGURATION);
    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      sendWebRtcSignal(socketRef.current, hostClientId, {
        kind: 'ice_candidate',
        candidate: event.candidate.toJSON(),
      });
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (event.track.kind === 'audio' && stream.getVideoTracks().length === 0) {
        attachGuestChatAudioTrack(event.track);
        return;
      }
      if (event.track.kind === 'video') {
        guestVideoReceiverRef.current = event.receiver;
        applyGuestVideoReceiverLatencyHint(event.receiver, 'default');
        try {
          if (event.track.contentHint !== 'motion') {
            event.track.contentHint = 'motion';
          }
        } catch {
          // Ignore content hint failures; playback can proceed with defaults.
        }
      }

      const video = hostStreamVideoRef.current;
      const hadAssignedStream = Boolean(video?.srcObject);
      if (video && video.srcObject !== stream) {
        wireGuestVideoStatusHandlers(video);
        video.srcObject = stream;
        video.muted = lobbyAudioMuted;
        video.volume = lobbyAudioMuted ? 0 : clampVolume(guestGameAudioVolume);
        void video.play().catch(() => {
          // Autoplay can be blocked on some browsers until interaction.
        });
      }
      setGuestStreamAttached(true);
      setHostStreamStatus(hadAssignedStream ? 'live' : 'connecting');
      setGuestPlaybackState(hadAssignedStream ? 'live' : 'starting');
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'disconnected') {
        setGuestPlaybackState((current) => (current === 'live' ? 'recovering' : current));
        scheduleGuestAutoResync();
        return;
      }
      if (connection.connectionState === 'failed') {
        setHostStreamStatus('error');
        setGuestPlaybackState('recovering');
        return;
      }
      if (connection.connectionState === 'closed') {
        setHostStreamStatus('idle');
        setGuestPlaybackState('starting');
      }
    };

    if (
      guestVoiceLocalTrackRef.current &&
      guestVoiceLocalStreamRef.current &&
      Boolean(session?.voiceEnabled) &&
      !voiceInputMuted
    ) {
      guestVoiceSenderRef.current = connection.addTrack(guestVoiceLocalTrackRef.current, guestVoiceLocalStreamRef.current);
    }

    guestPeerConnectionRef.current = connection;
    return connection;
  }, [
    attachGuestChatAudioTrack,
    applyGuestVideoReceiverLatencyHint,
    guestGameAudioVolume,
    lobbyAudioMuted,
    scheduleGuestAutoResync,
    session?.voiceEnabled,
    voiceInputMuted,
    wireGuestVideoStatusHandlers,
  ]);

  const flushPendingGuestIceCandidates = useCallback((connection: RTCPeerConnection): void => {
    if (guestPendingIceCandidatesRef.current.length === 0) {
      return;
    }

    const queued = [...guestPendingIceCandidatesRef.current];
    guestPendingIceCandidatesRef.current = [];
    for (const candidate of queued) {
      void connection.addIceCandidate(candidate).catch(() => {
        // Ignore individual candidate failures to keep stream negotiation alive.
      });
    }
  }, []);

  const handleGuestWebRtcSignal = useCallback((message: WebRtcSignalMessage): void => {
    if (isHost) {
      return;
    }

    if (message.payload.kind === 'offer') {
      const hostClientId = message.fromClientId;
      const offerSdp = message.payload.sdp;
      const peer = ensureGuestPeerConnection(hostClientId);
      setHostStreamStatus((current) => (current === 'live' && guestStreamAttached ? current : 'connecting'));

      void (async () => {
        try {
          await peer.setRemoteDescription({
            type: 'offer',
            sdp: offerSdp,
          });
          flushPendingGuestIceCandidates(peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          const localDescription = peer.localDescription;
          if (!localDescription?.sdp) {
            throw new Error('Missing local SDP answer.');
          }
          sendWebRtcSignal(socketRef.current, hostClientId, {
            kind: 'answer',
            sdp: localDescription.sdp,
          });
        } catch {
          setHostStreamStatus('error');
          clearGuestPeerConnection();
        }
      })();
      return;
    }

    if (message.payload.kind === 'ice_candidate') {
      const candidate = message.payload.candidate;
      const peer = guestPeerConnectionRef.current;
      if (!peer || !peer.remoteDescription) {
        guestPendingIceCandidatesRef.current.push(candidate);
        return;
      }

      void peer.addIceCandidate(candidate).catch(() => {
        // Ignore invalid candidate fragments.
      });
    }
  }, [clearGuestPeerConnection, ensureGuestPeerConnection, flushPendingGuestIceCandidates, guestStreamAttached, isHost]);

  useEffect(() => {
    handleGuestWebRtcSignalRef.current = handleGuestWebRtcSignal;
  }, [handleGuestWebRtcSignal]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

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
    if (!isHost) {
      return;
    }
    setHostStreamStatus('idle');
    clearGuestPeerConnection();
  }, [clearGuestPeerConnection, isHost]);

  useEffect(() => {
    const video = hostStreamVideoRef.current;
    if (!video) {
      return;
    }
    video.muted = lobbyAudioMuted;
    video.volume = lobbyAudioMuted ? 0 : clampVolume(guestGameAudioVolume);
  }, [guestGameAudioVolume, lobbyAudioMuted]);

  useEffect(() => {
    applyGuestChatAudioVolume(guestChatAudioVolume);
  }, [applyGuestChatAudioVolume, guestChatAudioVolume]);

  useEffect(() => {
    if (isHost || !session?.voiceEnabled) {
      if (!voiceInputMuted) {
        setVoiceInputMuted(true);
      }
      setVoiceMicError(undefined);
      stopGuestVoiceCapture();
      return;
    }

    if (voiceInputMuted) {
      const voiceTrack = guestVoiceLocalTrackRef.current;
      if (voiceTrack) {
        voiceTrack.enabled = false;
      }
      if (guestVoiceSenderRef.current) {
        void guestVoiceSenderRef.current.replaceTrack(null).catch(() => {
          // Keep playback running even if sender detaches poorly on some browsers.
        });
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      const voiceTrack = await ensureGuestVoiceCapture();
      if (cancelled || !voiceTrack) {
        return;
      }
      voiceTrack.enabled = true;

      const connection = guestPeerConnectionRef.current;
      if (!connection || !guestVoiceLocalStreamRef.current) {
        return;
      }

      if (!guestVoiceSenderRef.current) {
        guestVoiceSenderRef.current = connection.addTrack(voiceTrack, guestVoiceLocalStreamRef.current);
        requestGuestStreamResync('manual', { silent: true, bypassCooldown: true });
        return;
      }

      void guestVoiceSenderRef.current.replaceTrack(voiceTrack).catch(() => {
        // Ignore replacement failures and keep stream playback active.
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ensureGuestVoiceCapture,
    isHost,
    requestGuestStreamResync,
    session?.voiceEnabled,
    stopGuestVoiceCapture,
    voiceInputMuted,
  ]);

  useEffect(() => {
    return () => {
      stopGuestVoiceCapture();
      clearGuestChatAudioPlayback();
    };
  }, [clearGuestChatAudioPlayback, stopGuestVoiceCapture]);

  useEffect(() => {
    return () => {
      clearReadyAutoLaunchTimer();
      clearGuestAutoResyncTimer();
      clearGuestBootstrapResyncTimer();
    };
  }, [clearGuestAutoResyncTimer, clearGuestBootstrapResyncTimer, clearReadyAutoLaunchTimer]);

  useEffect(() => {
    if (autoLaunchEligible) {
      if (readyAutoLaunchCountdown === null) {
        setReadyAutoLaunchCountdown(READY_AUTO_LAUNCH_COUNTDOWN_SECONDS);
      }
      return;
    }

    clearReadyAutoLaunchTimer();
    if (readyAutoLaunchCountdown !== null) {
      setReadyAutoLaunchCountdown(null);
    }
  }, [autoLaunchEligible, clearReadyAutoLaunchTimer, readyAutoLaunchCountdown]);

  useEffect(() => {
    if (readyAutoLaunchCountdown === null) {
      clearReadyAutoLaunchTimer();
      return;
    }

    if (!autoLaunchEligible) {
      setReadyAutoLaunchCountdown(null);
      return;
    }

    if (readyAutoLaunchCountdown <= 0) {
      clearReadyAutoLaunchTimer();
      if (autoLaunchRoute) {
        setAutoLaunchWhenReady(false);
        setReadyAutoLaunchCountdown(null);
        navigate(autoLaunchRoute);
      }
      return;
    }

    clearReadyAutoLaunchTimer();
    readyAutoLaunchTimerRef.current = window.setTimeout(() => {
      setReadyAutoLaunchCountdown((current) => {
        if (current === null) {
          return null;
        }
        return Math.max(0, current - 1);
      });
    }, 1_000);

    return () => {
      clearReadyAutoLaunchTimer();
    };
  }, [autoLaunchEligible, autoLaunchRoute, clearReadyAutoLaunchTimer, navigate, readyAutoLaunchCountdown]);

  useEffect(() => {
    if (!normalizedCode) {
      return;
    }

    let cancelled = false;
    const loadSession = async (): Promise<void> => {
      const loaded = await refreshSessionSnapshot('poll');
      if (!loaded && !cancelled) {
        setError('Failed to load session.');
      }
    };

    void loadSession();
    const pollIntervalMs =
      socketStatus === 'connected'
        ? documentVisible
          ? SESSION_SNAPSHOT_POLL_MS_CONNECTED
          : SESSION_SNAPSHOT_POLL_MS_CONNECTED * 2
        : documentVisible
          ? SESSION_SNAPSHOT_POLL_MS_DISCONNECTED
          : SESSION_SNAPSHOT_POLL_MS_DISCONNECTED * 2;
    const interval = window.setInterval(() => {
      void loadSession();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [documentVisible, normalizedCode, refreshSessionSnapshot, socketStatus]);

  useEffect(() => {
    if (!normalizedCode || !documentVisible) {
      return;
    }
    void refreshSessionSnapshot('poll');
  }, [documentVisible, normalizedCode, refreshSessionSnapshot]);

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
      socket.send(
        JSON.stringify({
          type: 'ping',
          sentAt: pendingPingSentAtRef.current,
        }),
      );
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

      const existingSocket = socketRef.current;
      if (existingSocket && (existingSocket.readyState === WebSocket.OPEN || existingSocket.readyState === WebSocket.CONNECTING)) {
        return;
      }

      setSocketStatus((current) => (current === 'connecting' ? current : 'connecting'));
      const socket = new WebSocket(multiplayerSocketUrl(normalizedCode, clientId));
      socketRef.current = socket;
      const isCurrentSocket = (): boolean => socketRef.current === socket;

      socket.onopen = () => {
        if (cancelled || !isCurrentSocket()) {
          return;
        }

        setSocketStatus('connected');
        setSessionClosedReason(undefined);
        setError(undefined);
        setLatencyMs(undefined);
        setLatencyHistory([]);
        clearHeartbeatTimer();
        sendPing(socket);

        heartbeatTimerRef.current = window.setInterval(() => {
          sendPing(socket);
        }, SOCKET_HEARTBEAT_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (!isCurrentSocket()) {
          return;
        }
        const message = typeof event.data === 'string' ? tryParseSocketMessage(event.data) : null;
        if (!message) {
          return;
        }

        if (message.type === 'pong') {
          if (pendingPingSentAtRef.current) {
            const nextLatency = Math.max(1, Date.now() - pendingPingSentAtRef.current);
            setLatencyMs((current) =>
              current === undefined || Math.abs(current - nextLatency) >= 2 ? nextLatency : current,
            );
            setLatencyHistory((current) => {
              const last = current[current.length - 1];
              if (last !== undefined && Math.abs(last - nextLatency) < 2) {
                return current;
              }
              return [...current, nextLatency].slice(-LATENCY_HISTORY_LIMIT);
            });
          }
          return;
        }

        if (message.type === 'room_state') {
          applySessionSnapshotIfChanged(normalizeSessionSnapshot(message.session));
          return;
        }

        if (message.type === 'member_latency') {
          setSession((current) => {
            if (!current) {
              return current;
            }
            let changed = false;
            const nextMembers = current.members.map((member) => {
              if (member.clientId !== message.clientId) {
                return member;
              }
              const currentPing = member.pingMs;
              const nextPing = message.pingMs;
              if (
                currentPing === nextPing ||
                (typeof currentPing === 'number' &&
                  typeof nextPing === 'number' &&
                  Math.abs(currentPing - nextPing) < 4)
              ) {
                return member;
              }
              changed = true;
              return {
                ...member,
                pingMs: message.pingMs,
              };
            });
            if (!changed) {
              return current;
            }
            return {
              ...current,
              members: nextMembers,
            };
          });
          return;
        }

        if (message.type === 'webrtc_signal') {
          handleGuestWebRtcSignalRef.current?.(message);
          return;
        }

        if (message.type === 'remote_input') {
          if (!captureRemoteInputDiagnosticsRef.current) {
            return;
          }
          const parsedPayload = parseRemoteInputPayload(message.payload);
          const nextEvent = {
            fromName: message.fromName,
            fromSlot: message.fromSlot,
            at: message.at,
            payload: parsedPayload,
          };
          if (hostRemoteFeedPausedRef.current) {
            bufferedRemoteInputsRef.current = appendRemoteInputEvent(bufferedRemoteInputsRef.current, nextEvent);
            schedulePausedFeedCountFlushRef.current?.();
            return;
          }

          pendingRemoteInputsRef.current.push(nextEvent);
          scheduleRemoteInputFlushRef.current?.(hostRemoteFeedUiActiveRef.current ? 'visible' : 'background');
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
          setHostStreamStatus('idle');
          clearGuestPeerConnection();
          clearReconnectTimer();
          clearHeartbeatTimer();
          setSocketStatus('disconnected');
          socket.close();
          return;
        }

        if (message.type === 'kicked') {
          sessionClosedRef.current = true;
          setSessionClosedReason(message.reason || 'You were removed by host.');
          setHostStreamStatus('idle');
          clearGuestPeerConnection();
          clearReconnectTimer();
          clearHeartbeatTimer();
          setSocketStatus('disconnected');
          socket.close();
        }
      };

      socket.onclose = () => {
        if (!isCurrentSocket()) {
          return;
        }
        socketRef.current = null;
        clearHeartbeatTimer();
        clearGuestHardResyncTimer();
        if (cancelled) {
          return;
        }

        setSocketStatus('disconnected');
        if (sessionClosedRef.current) {
          setHostStreamStatus('idle');
          clearGuestPeerConnection();
          return;
        }
        if (isHostRef.current) {
          setHostStreamStatus('idle');
        } else {
          setHostStreamStatus((current) => (current === 'live' ? current : 'connecting'));
          setGuestPlaybackState((current) => (current === 'live' ? current : 'recovering'));
        }
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (!isCurrentSocket()) {
          return;
        }
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
      clearGuestPeerConnection();
      clearReconnectTimer();
      clearHeartbeatTimer();
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
    };
  }, [
    applySessionSnapshotIfChanged,
    clearGuestHardResyncTimer,
    clearGuestPeerConnection,
    clientId,
    normalizedCode,
  ]);

  useEffect(() => {
    if (isHost || hostStreamStatus === 'idle' || hostStreamStatus === 'error' || !guestStreamAttached) {
      guestStreamStatsBaselineRef.current = undefined;
      guestStreamBufferDelayMsRef.current = 0;
      setGuestStreamTelemetryIfChanged({});
      return;
    }

    let cancelled = false;

    const pollGuestStreamTelemetry = async (): Promise<void> => {
      const peer = guestPeerConnectionRef.current;
      if (!peer) {
        if (!cancelled) {
          setGuestStreamTelemetryIfChanged({});
        }
        return;
      }

      try {
        const stats = await peer.getStats();
        let inbound: RTCInboundRtpStreamStats | undefined;
        let candidatePair: RTCIceCandidatePairStats | undefined;

        for (const report of stats.values()) {
          const inboundVideo = inboundVideoStats(report);
          if (inboundVideo) {
            inbound = inboundVideo;
          }

          if (report.type === 'candidate-pair') {
            const pair = report as RTCIceCandidatePairStats & { selected?: boolean };
            if (
              typeof pair.currentRoundTripTime === 'number' &&
              (pair.selected || pair.nominated || !candidatePair)
            ) {
              candidatePair = pair;
            }
          }
        }

        if (!inbound) {
          if (!cancelled) {
            guestStreamBufferDelayMsRef.current = 0;
            setGuestStreamTelemetryIfChanged({});
          }
          return;
        }

        const measuredAtMs = performance.now();
        let bitrateKbps: number | undefined;
        let bufferDelayMs: number | undefined;
        if (typeof inbound.bytesReceived === 'number') {
          const previous = guestStreamStatsBaselineRef.current;
          if (
            previous &&
            measuredAtMs > previous.measuredAtMs &&
            inbound.bytesReceived >= previous.bytesReceived
          ) {
            const deltaBytes = inbound.bytesReceived - previous.bytesReceived;
            const deltaSeconds = (measuredAtMs - previous.measuredAtMs) / 1_000;
            if (deltaSeconds > 0) {
              bitrateKbps = Math.round((deltaBytes * 8) / 1_000 / deltaSeconds);
            }
          }
          guestStreamStatsBaselineRef.current = {
            bytesReceived: inbound.bytesReceived,
            measuredAtMs,
          };
        }
        if (
          typeof inbound.jitterBufferDelay === 'number' &&
          typeof inbound.jitterBufferEmittedCount === 'number' &&
          inbound.jitterBufferEmittedCount > 0
        ) {
          bufferDelayMs = Math.round((inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1_000);
        }
        guestStreamBufferDelayMsRef.current = bufferDelayMs ?? 0;

        if (cancelled) {
          return;
        }

        setGuestStreamTelemetryIfChanged({
          bitrateKbps,
          fps:
            typeof inbound.framesPerSecond === 'number'
              ? Number(inbound.framesPerSecond.toFixed(1))
              : undefined,
          jitterMs: typeof inbound.jitter === 'number' ? Math.round(inbound.jitter * 1_000) : undefined,
          rttMs:
            typeof candidatePair?.currentRoundTripTime === 'number'
              ? Math.round(candidatePair.currentRoundTripTime * 1_000)
              : undefined,
          bufferDelayMs,
        });
      } catch {
        if (!cancelled) {
          guestStreamBufferDelayMsRef.current = 0;
          setGuestStreamTelemetryIfChanged({});
        }
      }
    };

    void pollGuestStreamTelemetry();
    const timer = window.setInterval(() => {
      void pollGuestStreamTelemetry();
    }, GUEST_STREAM_STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [guestStreamAttached, hostStreamStatus, isHost, setGuestStreamTelemetryIfChanged]);

  useEffect(() => {
    if (isHost || hostStreamStatus !== 'live' || !guestStreamAttached) {
      guestLastPlaybackProgressAtRef.current = 0;
      guestLastPlaybackTimeRef.current = 0;
      guestLastPlaybackFramesRef.current = 0;
      guestStreamLiveAtRef.current = 0;
      return;
    }

    const timer = window.setInterval(() => {
      const video = hostStreamVideoRef.current;
      if (!video) {
        return;
      }
      if (document.visibilityState === 'hidden') {
        if (video.playbackRate !== 1) {
          video.playbackRate = 1;
        }
        return;
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.ended) {
        if (video.playbackRate !== 1) {
          video.playbackRate = 1;
        }
        return;
      }

      const nowPerf = performance.now();
      if (guestStreamLiveAtRef.current > 0 && nowPerf - guestStreamLiveAtRef.current < GUEST_STALL_WARMUP_GRACE_MS) {
        return;
      }
      const bufferDelayMs = guestStreamBufferDelayMsRef.current;
      const shouldCatchUp =
        bufferDelayMs >= GUEST_PLAYBACK_CATCH_UP_MIN_BUFFER_MS &&
        bufferDelayMs <= GUEST_PLAYBACK_CATCH_UP_MAX_BUFFER_MS;
      if (shouldCatchUp) {
        applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'recovery');
        if (video.playbackRate !== GUEST_PLAYBACK_CATCH_UP_RATE) {
          video.playbackRate = GUEST_PLAYBACK_CATCH_UP_RATE;
        }
      } else if (video.playbackRate !== 1) {
        applyGuestVideoReceiverLatencyHint(guestVideoReceiverRef.current, 'default');
        video.playbackRate = 1;
      }
      const currentTime = video.currentTime;
      const currentFrames =
        typeof video.getVideoPlaybackQuality === 'function'
          ? video.getVideoPlaybackQuality().totalVideoFrames
          : 0;

      const timeProgressed = currentTime - guestLastPlaybackTimeRef.current > 0.03;
      const framesProgressed = currentFrames > guestLastPlaybackFramesRef.current;
      if (timeProgressed || framesProgressed) {
        guestLastPlaybackProgressAtRef.current = nowPerf;
        guestLastPlaybackTimeRef.current = currentTime;
        guestLastPlaybackFramesRef.current = currentFrames;
        setGuestPlaybackState((current) => (current === 'live' ? current : 'live'));
        return;
      }

      if (guestLastPlaybackProgressAtRef.current === 0) {
        guestLastPlaybackProgressAtRef.current = nowPerf;
        guestLastPlaybackTimeRef.current = currentTime;
        guestLastPlaybackFramesRef.current = currentFrames;
        return;
      }

      const stalledMs = nowPerf - guestLastPlaybackProgressAtRef.current;
      if (stalledMs < GUEST_STALL_NO_PROGRESS_MS) {
        return;
      }

      setGuestPlaybackState((current) => (current === 'recovering' ? current : 'stalled'));
      if (!autoStallRecoveryEnabled || !canSendRealtimeInput) {
        return;
      }

      const nowWall = Date.now();
      if (nowWall - lastGuestStallRecoveryAtRef.current < GUEST_STALL_RECOVERY_COOLDOWN_MS) {
        return;
      }

      setGuestPlaybackState('recovering');
      const requested = requestGuestStreamResync('auto', { silent: true });
      if (requested) {
        lastGuestStallRecoveryAtRef.current = nowWall;
        setClipboardFeedback('Detected frozen stream playback. Auto-recovering now.');
      } else {
        setGuestPlaybackState('stalled');
      }
    }, GUEST_STALL_PROBE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    applyGuestVideoReceiverLatencyHint,
    autoStallRecoveryEnabled,
    canSendRealtimeInput,
    guestStreamAttached,
    hostStreamStatus,
    isHost,
    requestGuestStreamResync,
    setClipboardFeedback,
  ]);

  useEffect(() => {
    const romId = session?.romId ?? null;
    if (
      isHost ||
      !autoStallRecoveryEnabled ||
      !canSendRealtimeInput ||
      !romId ||
      hostStreamStatus === 'live' ||
      guestStreamAttached ||
      hostStreamStatus === 'connecting'
    ) {
      clearGuestBootstrapResyncTimer();
      return;
    }

    if (guestBootstrapResyncAttemptedRomRef.current === romId) {
      return;
    }

    if (guestBootstrapResyncTimerRef.current !== null) {
      return;
    }
    const now = Date.now();
    if (now - guestBootstrapResyncLastRequestedAtRef.current < GUEST_BOOTSTRAP_RESYNC_COOLDOWN_MS) {
      return;
    }

    guestBootstrapResyncAttemptedRomRef.current = romId;
    guestBootstrapResyncTimerRef.current = window.setTimeout(() => {
      guestBootstrapResyncTimerRef.current = null;
      guestBootstrapResyncLastRequestedAtRef.current = Date.now();
      requestGuestStreamResync('auto');
    }, GUEST_BOOTSTRAP_RESYNC_DELAY_MS);

    return () => {
      clearGuestBootstrapResyncTimer();
    };
  }, [
    autoStallRecoveryEnabled,
    canSendRealtimeInput,
    clearGuestBootstrapResyncTimer,
    guestStreamAttached,
    hostStreamStatus,
    isHost,
    requestGuestStreamResync,
    session?.romId,
  ]);

  useEffect(() => {
    if (!session?.romId) {
      guestBootstrapResyncAttemptedRomRef.current = null;
      guestBootstrapResyncLastRequestedAtRef.current = 0;
      return;
    }
    if (hostStreamStatus === 'live') {
      guestBootstrapResyncAttemptedRomRef.current = session.romId;
    }
  }, [hostStreamStatus, session?.romId]);

  useEffect(() => {
    const onFullscreenChange = (): void => {
      const shell = hostStreamShellRef.current;
      if (!shell) {
        setIsGuestStreamFullscreen(false);
        return;
      }
      setIsGuestStreamFullscreen(document.fullscreenElement === shell);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  const emitRemoteDigitalControl = useCallback((payload: MultiplayerDigitalInputPayload): void => {
    if (!canSendGuestControllerInput || isHost) {
      return;
    }
    sendInputPayload(socketRef.current, payload);
  }, [canSendGuestControllerInput, isHost]);

  const emitRemoteAnalogState = useCallback((x: number, y: number): void => {
    if (!canSendGuestControllerInput || isHost) {
      return;
    }

    sendInputPayload(socketRef.current, buildAnalogInputPayload(x, y));
  }, [canSendGuestControllerInput, isHost]);

  const maybeEmitRemoteAnalogState = useCallback((x: number, y: number, options?: { force?: boolean }): void => {
    const nextAnalog = {
      x: Math.abs(x) <= REMOTE_ANALOG_ZERO_THRESHOLD ? 0 : clamp(x, -1, 1),
      y: Math.abs(y) <= REMOTE_ANALOG_ZERO_THRESHOLD ? 0 : clamp(y, -1, 1),
    };
    const previousAnalog = remoteAnalogStateRef.current;
    const now = performance.now();
    const analogMovedEnough =
      Math.abs(nextAnalog.x - previousAnalog.x) >= guestInputRelayProfile.deltaThreshold ||
      Math.abs(nextAnalog.y - previousAnalog.y) >= guestInputRelayProfile.deltaThreshold;
    const analogReturnedToNeutral =
      (nextAnalog.x === 0 && previousAnalog.x !== 0) ||
      (nextAnalog.y === 0 && previousAnalog.y !== 0);
    const analogIsActive = nextAnalog.x !== 0 || nextAnalog.y !== 0;
    const heartbeatExpired = now - remoteAnalogLastSentAtRef.current >= guestInputRelayProfile.idleHeartbeatMs;
    const minIntervalElapsed = now - remoteAnalogLastSentAtRef.current >= guestInputRelayProfile.sendIntervalMs;
    const force = Boolean(options?.force);

    if (
      force ||
      (minIntervalElapsed &&
        (analogMovedEnough || analogReturnedToNeutral || (analogIsActive && heartbeatExpired)))
    ) {
      emitRemoteAnalogState(nextAnalog.x, nextAnalog.y);
      remoteAnalogStateRef.current = nextAnalog;
      remoteAnalogLastSentAtRef.current = now;
    }
  }, [emitRemoteAnalogState, guestInputRelayProfile.deltaThreshold, guestInputRelayProfile.idleHeartbeatMs, guestInputRelayProfile.sendIntervalMs]);

  const emitRemoteControlState = useCallback((control: N64ControlTarget, pressed: boolean): void => {
    emitRemoteDigitalControl(buildDigitalInputPayload(control, pressed));
  }, [emitRemoteDigitalControl]);

  const sendQuickTap = (control: N64ControlTarget): void => {
    if (!canSendGuestControllerInput || isHost) {
      return;
    }

    emitRemoteControlState(control, true);

    window.setTimeout(() => {
      emitRemoteControlState(control, false);
    }, 80);
  };

  const releaseHeldQuickControl = useCallback((control: N64ControlTarget): void => {
    if (!quickHoldControlsRef.current.has(control)) {
      return;
    }
    quickHoldControlsRef.current.delete(control);
    setActiveQuickHoldControls(Array.from(quickHoldControlsRef.current.values()));
    emitRemoteControlState(control, false);
  }, [emitRemoteControlState]);

  const releaseAllHeldQuickControls = useCallback((): void => {
    const heldControls = Array.from(quickHoldControlsRef.current.values());
    if (heldControls.length === 0) {
      return;
    }
    quickHoldControlsRef.current.clear();
    setActiveQuickHoldControls([]);
    for (const control of heldControls) {
      emitRemoteControlState(control, false);
    }
  }, [emitRemoteControlState]);

  const onQuickInputPointerDown = (control: N64ControlTarget, event: PointerEvent<HTMLButtonElement>): void => {
    if (!canSendGuestControllerInput || isHost) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    suppressQuickTapUntilRef.current = performance.now() + 320;
    if (quickHoldControlsRef.current.has(control)) {
      return;
    }
    quickHoldControlsRef.current.add(control);
    setActiveQuickHoldControls(Array.from(quickHoldControlsRef.current.values()));
    emitRemoteControlState(control, true);
  };

  const onQuickInputClick = (control: N64ControlTarget): void => {
    if (performance.now() < suppressQuickTapUntilRef.current) {
      return;
    }
    sendQuickTap(control);
  };

  const onVirtualControlChange = (control: N64ControlTarget, pressed: boolean): void => {
    emitRemoteControlState(control, pressed);
  };

  const onVirtualAnalogChange = (x: number, y: number): void => {
    maybeEmitRemoteAnalogState(x, y, { force: x === 0 && y === 0 });
  };

  useEffect(() => {
    if (isHost || !canSendGuestControllerInput || !activeProfile || wizardOpen) {
      return;
    }

    const poller = createInputPoller(activeProfile, (inputState) => {
      const nextPressedState: Partial<Record<N64DigitalTarget, boolean>> = {};
      for (const control of DIGITAL_TARGETS) {
        nextPressedState[control] = inputState.buttons[control];
      }

      const previousPressedState = remotePressedStateRef.current;
      for (const control of DIGITAL_TARGETS) {
        const nextPressed = Boolean(nextPressedState[control]);
        const previousPressed = Boolean(previousPressedState[control]);
        if (nextPressed === previousPressed) {
          continue;
        }
        emitRemoteControlState(control, nextPressed);
      }

      remotePressedStateRef.current = nextPressedState;

      maybeEmitRemoteAnalogState(inputState.stick.x, inputState.stick.y);

      const gamepads = navigator.getGamepads?.() ?? [];
      setGamepadConnected(gamepads.some((pad) => Boolean(pad)));
    });

    return () => {
      poller.stop();
      for (const control of DIGITAL_TARGETS) {
        if (remotePressedStateRef.current[control]) {
          emitRemoteControlState(control, false);
        }
      }
      remotePressedStateRef.current = {};
      maybeEmitRemoteAnalogState(0, 0, { force: true });
      remoteAnalogStateRef.current = { x: 0, y: 0 };
      remoteAnalogLastSentAtRef.current = 0;
      releaseAllHeldQuickControls();
      setGamepadConnected(false);
    };
  }, [activeProfile, canSendGuestControllerInput, emitRemoteControlState, isHost, maybeEmitRemoteAnalogState, releaseAllHeldQuickControls, wizardOpen]);

  useEffect(() => {
    if (isHost || canSendGuestControllerInput) {
      return;
    }

    releaseAllHeldQuickControls();
  }, [canSendGuestControllerInput, isHost, releaseAllHeldQuickControls]);

  useEffect(() => {
    return () => {
      releaseAllHeldQuickControls();
    };
  }, [releaseAllHeldQuickControls]);

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

  const onCopySessionRoomLink = async (): Promise<void> => {
    if (!sessionShareUrl) {
      setClipboardFeedback('Room link is unavailable.');
      return;
    }

    try {
      await navigator.clipboard.writeText(sessionShareUrl);
      setClipboardFeedback('Room link copied.');
    } catch {
      setClipboardFeedback('Could not copy room link.');
    }
  };

  const onRequestHostStreamResync = useCallback((): void => {
    requestGuestStreamResync('manual');
  }, [requestGuestStreamResync]);

  const requestSocketReconnect = useCallback((): void => {
    if (sessionClosedReason) {
      setClipboardFeedback('This session is closed. Return to Online to start or join a new room.');
      return;
    }

    sessionClosedRef.current = false;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.CONNECTING) {
      setClipboardFeedback('Session connection is already being established.');
      return;
    }
    if (socket && socket.readyState === WebSocket.CLOSING) {
      setClipboardFeedback('Session connection is closing. Reconnect will resume shortly.');
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      setClipboardFeedback('Reconnecting session channel…');
      socket.close();
      return;
    }

    setSocketStatus('connecting');
    void refreshSessionSnapshot('manual');
    setClipboardFeedback('Reconnect requested. Waiting for session channel…');
  }, [refreshSessionSnapshot, sessionClosedReason, setClipboardFeedback]);

  const requestHostStreamQualityHint = useCallback(
    (options?: {
      requestedPreset?: HostStreamQualityPresetHint;
      reason?: string;
      source?: HostQualityHintRequestSource;
      enforceCooldown?: boolean;
      silent?: boolean;
    }): boolean => {
      const source = options?.source ?? 'manual';
      const silent = Boolean(options?.silent);
      const enforceCooldown = options?.enforceCooldown ?? true;
      if (isHost) {
        return false;
      }

      if (!canSendRealtimeInput) {
        if (!silent && source !== 'auto') {
          setClipboardFeedback('Connect before requesting stream quality changes.');
        }
        return false;
      }

      const now = Date.now();
      const cooldownRemainingMs =
        QUALITY_HINT_REQUEST_COOLDOWN_MS - (now - lastQualityHintRequestedAtRef.current);
      if (enforceCooldown && cooldownRemainingMs > 0) {
        if (!silent && source !== 'auto') {
          setClipboardFeedback(`Quality request cooling down (${Math.ceil(cooldownRemainingMs / 1000)}s).`);
        }
        return false;
      }

      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (!silent && source !== 'auto') {
          setClipboardFeedback('Realtime channel is unavailable for quality requests.');
        }
        return false;
      }

      const requestedPreset = options?.requestedPreset ?? suggestedHostPresetForGuest;
      const reason =
        options?.reason ??
        defaultQualityHintReason(requestedPreset, source, guestNetworkHealthStatus.label);

      socket.send(
        JSON.stringify({
          type: 'quality_hint',
          requestedPreset,
          reason,
        }),
      );

      lastQualityHintRequestedAtRef.current = now;
      if (source === 'auto') {
        lastAutoQualityHintAtRef.current = now;
        lastAutoQualityHintPresetRef.current = requestedPreset;
      }
      if (!silent) {
        if (source === 'auto') {
          setClipboardFeedback(`Auto-requested host stream mode: ${HOST_STREAM_PRESET_LABELS[requestedPreset]}.`);
        } else if (source === 'rescue') {
          setClipboardFeedback(`Latency rescue requested: ${HOST_STREAM_PRESET_LABELS[requestedPreset]}.`);
        } else {
          setClipboardFeedback(`Requested host stream mode: ${HOST_STREAM_PRESET_LABELS[requestedPreset]}.`);
        }
      }
      return true;
    },
    [canSendRealtimeInput, guestNetworkHealthStatus.label, isHost, setClipboardFeedback, suggestedHostPresetForGuest],
  );

  const onLatencyRescue = useCallback((): void => {
    if (isHost) {
      return;
    }

    const now = Date.now();
    const cooldownRemainingMs = LATENCY_RESCUE_COOLDOWN_MS - (now - lastLatencyRescueAtRef.current);
    if (cooldownRemainingMs > 0) {
      setClipboardFeedback(`Latency rescue cooling down (${Math.ceil(cooldownRemainingMs / 1000)}s).`);
      return;
    }
    lastLatencyRescueAtRef.current = now;

    setGuestFocusMode(true);
    setShowGuestInputDeck(false);
    setGuestInputRelayMode('responsive');
    setAutoQualityHintEnabled(true);
    setShowGuestDiagnostics(false);
    setVirtualControllerCollapsed(false);

    const resyncRequested = requestGuestStreamResync('manual', { silent: true });
    const qualityRequested = requestHostStreamQualityHint({
      source: 'rescue',
      requestedPreset: 'ultra_low_latency',
      reason: 'Latency rescue requested by guest to prioritize responsiveness.',
      enforceCooldown: true,
      silent: true,
    });

    if (!resyncRequested && !qualityRequested) {
      setClipboardFeedback('Latency rescue primed locally. Connect to relay stream rescue requests.');
      return;
    }

    const actions: string[] = [];
    if (qualityRequested) {
      actions.push('requested Ultra Low Latency stream');
    }
    if (resyncRequested) {
      actions.push('requested stream re-sync');
    }
    setClipboardFeedback(`Latency rescue engaged: ${actions.join(' + ')}.`);
  }, [
    isHost,
    requestGuestStreamResync,
    requestHostStreamQualityHint,
    setClipboardFeedback,
    setShowGuestInputDeck,
    setShowGuestDiagnostics,
    setVirtualControllerCollapsed,
  ]);

  const toggleGuestPlayersPanel = useCallback((): void => {
    if (guestFocusMode) {
      setGuestFocusMode(false);
      setGuestPlayersCollapsed(false);
      return;
    }
    setGuestPlayersCollapsed((value) => !value);
  }, [guestFocusMode]);

  const toggleGuestChatPanel = useCallback((): void => {
    if (guestFocusMode) {
      setGuestFocusMode(false);
      setGuestChatCollapsed(false);
      return;
    }
    setGuestChatCollapsed((value) => !value);
  }, [guestFocusMode]);

  const toggleHostRemoteFeedPanel = useCallback((): void => {
    if (hostControlsCollapsed) {
      setHostControlsCollapsed(false);
      setHostRemoteFeedCollapsed(false);
      setHostRemoteFeedAutoFollow(true);
      setHostRemoteFeedDetachedCount(0);
      setHostLastSeenRemoteFeedCount(remoteInputs.length);
      return;
    }
    if (hostRemoteFeedCollapsed) {
      setHostRemoteFeedCollapsed(false);
      setHostRemoteFeedAutoFollow(true);
      setHostRemoteFeedDetachedCount(0);
      setHostLastSeenRemoteFeedCount(remoteInputs.length);
      return;
    }
    setHostRemoteFeedCollapsed(true);
  }, [hostControlsCollapsed, hostRemoteFeedCollapsed, remoteInputs.length]);

  const scrollToPanel = useCallback((panel: 'players' | 'controls' | 'chat'): void => {
    const target =
      panel === 'players' ? playersPanelRef.current : panel === 'controls' ? hostControlsPanelRef.current : chatPanelRef.current;
    if (!target) {
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const onJumpToHostRomSetup = useCallback((): void => {
    if (!isHost) {
      return;
    }
    setHostControlsCollapsed(false);
    setHostRemoteFeedCollapsed(true);
    setHostQuickbarExpanded(false);
    setCompactSessionDetailsExpanded(false);
    window.setTimeout(() => scrollToPanel('controls'), 60);
    setClipboardFeedback('Jumped to Host Controls. Pick a ROM to launch.');
  }, [isHost, scrollToPanel, setClipboardFeedback]);

  const resetGuestPhoneLayout = useCallback((): void => {
    setGuestFocusMode(true);
    setShowGuestInputDeck(false);
    setShowVirtualController(coarsePointer);
    setVirtualControllerMode('compact');
    setVirtualControllerCollapsed(false);
    setGuestPlayersCollapsed(true);
    setGuestChatCollapsed(true);
    setShowGuestDiagnostics(false);
    setGuestQuickbarExpanded(false);
    setClipboardFeedback('Guest phone layout reset.');
  }, [coarsePointer, setClipboardFeedback]);

  const onTurboLatencyMode = useCallback((): void => {
    if (isHost) {
      return;
    }
    setGuestFocusMode(true);
    setShowGuestInputDeck(false);
    setShowVirtualController(true);
    setVirtualControllerCollapsed(false);
    setGuestInputRelayMode('responsive');
    setShowGuestDiagnostics(false);
    setAutoQualityHintEnabled(true);
    const resyncRequested = requestGuestStreamResync('manual', { silent: true });
    const hintRequested = requestHostStreamQualityHint({
      source: 'manual',
      requestedPreset: 'ultra_low_latency',
      reason: 'Guest enabled Turbo Latency mode.',
      enforceCooldown: false,
      silent: true,
    });
    if (resyncRequested || hintRequested) {
      setClipboardFeedback('Turbo latency mode enabled.');
    } else {
      setClipboardFeedback('Turbo latency mode configured locally.');
    }
  }, [
    isHost,
    requestGuestStreamResync,
    requestHostStreamQualityHint,
    setClipboardFeedback,
    setShowGuestDiagnostics,
    setShowGuestInputDeck,
    setShowVirtualController,
    setVirtualControllerCollapsed,
  ]);

  const onBalancedGuestMode = useCallback((): void => {
    if (isHost) {
      return;
    }
    setGuestFocusMode(false);
    setShowGuestInputDeck(true);
    setShowVirtualController(coarsePointer);
    setVirtualControllerCollapsed(false);
    setGuestPlayersCollapsed(false);
    setGuestChatCollapsed(false);
    setGuestInputRelayMode('balanced');
    setShowGuestDiagnostics(true);
    setAutoQualityHintEnabled(true);
    setAutoStallRecoveryEnabled(true);
    const requested = requestHostStreamQualityHint({
      source: 'manual',
      requestedPreset: 'balanced',
      reason: 'Guest enabled Balanced Play mode.',
      enforceCooldown: false,
      silent: true,
    });
    setClipboardFeedback(requested ? 'Balanced play mode enabled.' : 'Balanced play mode configured locally.');
  }, [
    coarsePointer,
    isHost,
    requestHostStreamQualityHint,
    setClipboardFeedback,
    setShowGuestDiagnostics,
    setShowGuestInputDeck,
    setShowVirtualController,
    setVirtualControllerCollapsed,
  ]);

  const onSmartAutoGuestMode = useCallback((): void => {
    if (isHost) {
      return;
    }
    const compactMode = isPhoneViewport;
    setGuestFocusMode(compactMode);
    setShowGuestInputDeck(!compactMode);
    setShowVirtualController(coarsePointer);
    setVirtualControllerMode(compactMode ? 'compact' : 'full');
    setVirtualControllerCollapsed(false);
    setGuestPlayersCollapsed(compactMode);
    setGuestChatCollapsed(compactMode);
    setGuestInputRelayMode('auto');
    setShowGuestDiagnostics(!compactMode);
    setAutoQualityHintEnabled(true);
    setAutoStallRecoveryEnabled(true);
    const requested = requestHostStreamQualityHint({
      source: 'manual',
      requestedPreset: suggestedHostPresetForGuest,
      reason: 'Guest enabled Smart Auto mode.',
      enforceCooldown: false,
      silent: true,
    });
    setClipboardFeedback(requested ? 'Smart auto mode synced with host stream suggestion.' : 'Smart auto mode enabled.');
  }, [
    coarsePointer,
    isHost,
    isPhoneViewport,
    requestHostStreamQualityHint,
    setClipboardFeedback,
    suggestedHostPresetForGuest,
  ]);

  const onToggleGuestDiagnostics = useCallback((): void => {
    if (isHost) {
      return;
    }
    setShowGuestDiagnostics((value) => !value);
  }, [isHost]);

  const guestRecoveryAction = useMemo(() => {
    if (socketStatus !== 'connected') {
      return {
        key: 'reconnect',
        label: 'Reconnect Session',
        hint: 'Connection dropped. Re-open realtime channel before sending stream commands.',
        onClick: requestSocketReconnect,
        disabled: false,
      } as const;
    }

    if (hostStreamStatus === 'idle') {
      return {
        key: 'request_stream',
        label: 'Request Stream',
        hint: 'Ask the host to restart ROM streaming from gameplay view.',
        onClick: onRequestHostStreamResync,
        disabled: !canSendRealtimeInput,
      } as const;
    }

    if (hostStreamStatus === 'error' || guestPlaybackState === 'stalled') {
      return {
        key: 'latency_rescue',
        label: 'Latency Rescue',
        hint: 'Playback is unstable. Rescue prioritizes low latency and requests stream recovery.',
        onClick: onLatencyRescue,
        disabled: !canSendRealtimeInput,
      } as const;
    }

    return {
      key: 'resync',
      label: 'Re-sync Stream',
      hint: 'Request a fresh host stream negotiation if playback drifts or freezes.',
      onClick: onRequestHostStreamResync,
      disabled: !canSendRealtimeInput,
    } as const;
  }, [
    canSendRealtimeInput,
    guestPlaybackState,
    hostStreamStatus,
    onLatencyRescue,
    onRequestHostStreamResync,
    requestSocketReconnect,
    socketStatus,
  ]);

  const guestSuggestedActionText = useMemo(() => {
    if (guestRecoveryAction.key === 'reconnect') {
      return guestRecoveryAction.hint;
    }
    if (guestNetworkHealthStatus.label === 'Poor') {
      return 'Network is poor. Keep focus mode on and use Turbo Latency for responsive controls.';
    }
    if (guestNetworkHealthStatus.label === 'Fair') {
      return 'Network is fair. Balanced relay mode is recommended for smoother remote input.';
    }
    return guestRecoveryAction.hint;
  }, [guestNetworkHealthStatus.label, guestRecoveryAction.hint, guestRecoveryAction.key]);

  const onCopyHostDiagnostics = useCallback(async (): Promise<void> => {
    if (!isHost) {
      return;
    }
    const lines = [
      `Session ${normalizedCode}`,
      `Role: Host`,
      `Connection: ${socketStatus}`,
      `Relay latency: ${latencyMs !== undefined ? `${latencyMs}ms` : 'n/a'}`,
      `Relay avg/p95: ${latencySummary ? `${latencySummary.averageMs}ms / ${latencySummary.p95Ms}ms` : 'n/a'}`,
      `Players connected: ${connectedPlayers}/4`,
      `Ready: ${connectedReadyPlayers}/${connectedPlayers || 1}`,
      `Room joins: ${roomJoinLocked ? 'Locked' : 'Open'}`,
      `Guest relay health: ${hostRelayHealthSummary.label}`,
      `Host panels open: ${hostOpenPanelCount}/4`,
      `Unread chat: ${hostUnreadChatCount}`,
      `Unread feed: ${hostUnreadRemoteInputCount}`,
      `Feed paused: ${hostRemoteFeedPaused ? 'yes' : 'no'}`,
      `Feed buffered: ${hostRemoteFeedBufferedCount}`,
      `Feed filter: kind=${hostRemoteFeedFilterKind} slot=${hostRemoteFeedFilterSlot}`,
      `Feed visible: ${filteredRemoteInputs.length}`,
      `Host ROM: ${session?.romTitle ?? 'None selected'}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setClipboardFeedback('Host diagnostics copied.');
    } catch {
      setClipboardFeedback('Could not copy diagnostics.');
    }
  }, [
    connectedPlayers,
    connectedReadyPlayers,
    hostOpenPanelCount,
    hostRemoteFeedBufferedCount,
    hostRemoteFeedFilterKind,
    hostRemoteFeedFilterSlot,
    hostRemoteFeedPaused,
    hostRelayHealthSummary.label,
    hostUnreadChatCount,
    hostUnreadRemoteInputCount,
    isHost,
    latencyMs,
    latencySummary,
    normalizedCode,
    filteredRemoteInputs.length,
    roomJoinLocked,
    session?.romTitle,
    setClipboardFeedback,
    socketStatus,
  ]);

  const onCopySessionBrief = useCallback(async (): Promise<void> => {
    const roleLabel = currentMember
      ? `${slotLabel(currentMember.slot)}${isHost ? ' (Host)' : ''}`
      : isHost
        ? 'Host'
        : 'Guest (unassigned)';
    const lines = [
      `Warpdeck 64 Session ${normalizedCode}`,
      `Role: ${roleLabel}`,
      `Connection: ${socketStatus}`,
      `Room joins: ${roomJoinLocked ? 'Locked' : 'Open'}`,
      `Players: ${connectedPlayers}/4`,
      `Ready: ${connectedReadyPlayers}/${connectedPlayers || 1}`,
      `ROM: ${session?.romTitle ?? 'None selected'}`,
      `Invite code: ${normalizedCode}`,
    ];

    if (inviteJoinUrl) {
      lines.push(`Invite link: ${inviteJoinUrl}`);
    }
    if (sessionShareUrl) {
      lines.push(`Room link: ${sessionShareUrl}`);
    }
    lines.push(
      `Suggested next step: ${isHost ? hostQuickActionHint : guestSuggestedActionText}`,
    );

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setClipboardFeedback('Copied session brief.');
    } catch {
      setClipboardFeedback('Could not copy session brief.');
    }
  }, [
    connectedPlayers,
    connectedReadyPlayers,
    currentMember,
    guestSuggestedActionText,
    hostQuickActionHint,
    inviteJoinUrl,
    isHost,
    normalizedCode,
    roomJoinLocked,
    session?.romTitle,
    sessionShareUrl,
    setClipboardFeedback,
    socketStatus,
  ]);

  const applyGuestLayoutPreset = useCallback(
    (preset: GuestLayoutPreset): void => {
      if (preset === 'stream') {
        setGuestFocusMode(true);
        setShowGuestInputDeck(false);
        setShowVirtualController(false);
        setVirtualControllerCollapsed(true);
        setGuestPlayersCollapsed(true);
        setGuestChatCollapsed(true);
        setShowGuestDiagnostics(false);
        setClipboardFeedback('Guest layout: Stream focus.');
        return;
      }

      if (preset === 'controls') {
        setGuestFocusMode(true);
        setShowGuestInputDeck(true);
        setShowVirtualController(true);
        setVirtualControllerCollapsed(false);
        setGuestPlayersCollapsed(true);
        setGuestChatCollapsed(true);
        if (!isPhoneViewport) {
          setShowGuestDiagnostics(true);
        }
        setClipboardFeedback('Guest layout: Controller focus.');
        return;
      }

      setGuestFocusMode(false);
      setShowGuestInputDeck(true);
      setShowVirtualController(coarsePointer ? true : showVirtualController);
      setVirtualControllerCollapsed(false);
      setGuestPlayersCollapsed(false);
      setGuestChatCollapsed(false);
      if (!isPhoneViewport) {
        setShowGuestDiagnostics(true);
      }
      setClipboardFeedback('Guest layout: Full room view.');
    },
    [coarsePointer, isPhoneViewport, setClipboardFeedback, showVirtualController],
  );

  useEffect(() => {
    if (
      isHost ||
      !autoQualityHintEnabled ||
      !canSendRealtimeInput ||
      hostStreamStatus !== 'live' ||
      (guestNetworkHealthStatus.label !== 'Poor' && guestNetworkHealthStatus.label !== 'Fair') ||
      suggestedHostPresetForGuest === 'quality'
    ) {
      autoQualityDegradedSinceRef.current = null;
      return;
    }

    const now = Date.now();
    if (autoQualityDegradedSinceRef.current === null) {
      autoQualityDegradedSinceRef.current = now;
      return;
    }

    if (now - autoQualityDegradedSinceRef.current < AUTO_QUALITY_HINT_STABILITY_MS) {
      return;
    }

    if (now - lastAutoQualityHintAtRef.current < AUTO_QUALITY_HINT_MIN_INTERVAL_MS) {
      return;
    }

    const requestedPreset = suggestedHostPresetForGuest;
    const repeatedPreset = lastAutoQualityHintPresetRef.current === requestedPreset;
    if (repeatedPreset && now - lastAutoQualityHintAtRef.current < AUTO_QUALITY_HINT_REPEAT_INTERVAL_MS) {
      return;
    }

    void requestHostStreamQualityHint({
      source: 'auto',
      requestedPreset,
      enforceCooldown: true,
    });
  }, [
    autoQualityHintEnabled,
    canSendRealtimeInput,
    guestNetworkHealthStatus.label,
    hostStreamStatus,
    isHost,
    requestHostStreamQualityHint,
    suggestedHostPresetForGuest,
  ]);

  const onToggleGuestStreamFullscreen = async (): Promise<void> => {
    if (isHost) {
      return;
    }

    const shell = hostStreamShellRef.current;
    if (!shell) {
      setClipboardFeedback('Stream surface is not ready yet.');
      return;
    }

    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
        return;
      }
      await shell.requestFullscreen();
    } catch {
      setClipboardFeedback('Fullscreen is unavailable in this browser context.');
    }
  };

  useEffect(() => {
    if (isHost) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (settingsModalOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          setSettingsModalOpen(false);
          return;
        }
        event.preventDefault();
        return;
      }

      if (wizardOpen) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey && event.code === 'KeyT') {
        event.preventDefault();
        onTurboLatencyMode();
        return;
      }

      if (event.shiftKey && event.code === 'KeyB') {
        event.preventDefault();
        onBalancedGuestMode();
        return;
      }

      if (event.shiftKey && event.code === 'KeyA') {
        event.preventDefault();
        onSmartAutoGuestMode();
        return;
      }

      if (event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();
        onToggleGuestDiagnostics();
        return;
      }

      if (event.shiftKey && event.code === 'Digit1') {
        event.preventDefault();
        applyGuestLayoutPreset('stream');
        return;
      }

      if (event.shiftKey && event.code === 'Digit2') {
        event.preventDefault();
        applyGuestLayoutPreset('controls');
        return;
      }

      if (event.shiftKey && event.code === 'Digit3') {
        event.preventDefault();
        applyGuestLayoutPreset('all');
        return;
      }

      if (event.shiftKey && event.code === 'Digit0' && isPhoneViewport) {
        event.preventDefault();
        resetGuestPhoneLayout();
        return;
      }

      if (event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        void onCopySessionBrief();
        return;
      }

      if (!event.shiftKey && event.code === 'KeyF') {
        event.preventDefault();
        setGuestFocusMode((value) => !value);
        return;
      }

      if (!event.shiftKey && event.code === 'KeyV') {
        event.preventDefault();
        setShowVirtualController((value) => !value);
        return;
      }

      if (!event.shiftKey && event.code === 'KeyM') {
        event.preventDefault();
        setLobbyAudioMuted((value) => !value);
        return;
      }

      if (!event.shiftKey && event.code === 'KeyR') {
        event.preventDefault();
        requestGuestStreamResync('manual');
        return;
      }

      if (!event.shiftKey && event.code === 'KeyI') {
        event.preventDefault();
        setShowGuestInputDeck((value) => !value);
        return;
      }

      if (!event.shiftKey && event.code === 'KeyL') {
        event.preventDefault();
        onLatencyRescue();
        return;
      }

      if (!event.shiftKey && event.code === 'KeyC' && showVirtualController) {
        event.preventDefault();
        setVirtualControllerCollapsed((value) => !value);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    applyGuestLayoutPreset,
    isPhoneViewport,
    isHost,
    onBalancedGuestMode,
    onCopySessionBrief,
    onLatencyRescue,
    onSmartAutoGuestMode,
    onToggleGuestDiagnostics,
    onTurboLatencyMode,
    resetGuestPhoneLayout,
    requestGuestStreamResync,
    settingsModalOpen,
    showVirtualController,
    wizardOpen,
  ]);

  const onFocusChatComposer = useCallback((): void => {
    if (isCompactViewport && chatPanelCollapsed) {
      if (isHost) {
        setHostChatCollapsed(false);
      } else {
        setGuestFocusMode(false);
        setGuestChatCollapsed(false);
      }
    }

    window.setTimeout(() => {
      chatInputRef.current?.focus();
      chatInputRef.current?.select();
    }, 80);
  }, [chatPanelCollapsed, isCompactViewport, isHost]);

  const onRemoteFeedScroll = useCallback((): void => {
    const list = remoteFeedListRef.current;
    if (!list) {
      return;
    }
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atBottom = distanceFromBottom <= 20;
    setHostRemoteFeedAutoFollow(atBottom);
    if (atBottom) {
      setHostRemoteFeedDetachedCount(0);
    }
  }, []);

  const onJumpToLatestRemoteFeed = useCallback((): void => {
    const list = remoteFeedListRef.current;
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    }
    setHostRemoteFeedAutoFollow(true);
    setHostRemoteFeedDetachedCount(0);
    setHostLastSeenRemoteFeedCount(remoteInputs.length);
  }, [remoteInputs.length]);

  const onCopyRemoteFeed = useCallback(async (): Promise<void> => {
    if (filteredRemoteInputs.length === 0) {
      setClipboardFeedback('No feed events to copy.');
      return;
    }
    const lines = filteredRemoteInputs.map((event) => {
      return `${new Date(event.at).toLocaleTimeString()} | ${slotLabel(event.fromSlot)} (${event.fromName}) | ${describeRemoteInputPayload(event.payload)}`;
    });

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setClipboardFeedback(`Copied ${filteredRemoteInputs.length} remote feed events.`);
    } catch {
      setClipboardFeedback('Could not copy remote input feed.');
    }
  }, [filteredRemoteInputs, setClipboardFeedback]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const typingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (event.code === 'Slash' && !typingTarget) {
        event.preventDefault();
        onFocusChatComposer();
        return;
      }

      if (settingsModalOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          setSettingsModalOpen(false);
          return;
        }
        event.preventDefault();
        return;
      }

      if (event.code === 'Escape' && document.activeElement === chatInputRef.current) {
        chatInputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onFocusChatComposer, settingsModalOpen]);

  const sendChatMessage = useCallback((rawMessage: string, options?: { clearDraft?: boolean }): boolean => {
    if (!canSendRealtimeInput) {
      setClipboardFeedback('Connect before sending chat.');
      return false;
    }

    const message = rawMessage.trim();
    if (!message) {
      return false;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before sending chat.');
      return false;
    }

    socket.send(
      JSON.stringify({
        type: 'chat',
        text: message.slice(0, CHAT_MAX_LENGTH),
      }),
    );
    if (options?.clearDraft) {
      setChatDraft('');
    }
    return true;
  }, [canSendRealtimeInput, setClipboardFeedback]);

  const onSendReadyCheck = useCallback((): void => {
    if (!isHost) {
      return;
    }
    if (connectedHostGuestCount === 0) {
      setClipboardFeedback('No guests connected yet.');
      return;
    }

    const now = Date.now();
    const cooldownRemainingMs = HOST_READY_CHECK_COOLDOWN_MS - (now - lastHostReadyCheckAtRef.current);
    if (cooldownRemainingMs > 0) {
      setClipboardFeedback(`Ready check cooling down (${Math.ceil(cooldownRemainingMs / 1000)}s).`);
      return;
    }

    const readyMessage = `Ready check: ${connectedReadyPlayers}/${connectedPlayers || 1} ready. Please mark ready when set.`;
    if (!sendChatMessage(readyMessage)) {
      return;
    }

    lastHostReadyCheckAtRef.current = now;
    setClipboardFeedback('Ready check posted to session chat.');
  }, [connectedHostGuestCount, connectedPlayers, connectedReadyPlayers, isHost, sendChatMessage, setClipboardFeedback]);

  const onPingWaitingPlayers = useCallback((): void => {
    if (!isHost) {
      return;
    }
    if (waitingGuestMembers.length === 0) {
      setClipboardFeedback('No waiting guests to ping.');
      return;
    }
    const pingMessage = `Ready ping: ${waitingGuestNamesLabel}, please mark ready when you can.`;
    const sent = sendChatMessage(pingMessage);
    if (!sent) {
      return;
    }
    setClipboardFeedback('Pinged waiting guests in chat.');
  }, [isHost, sendChatMessage, setClipboardFeedback, waitingGuestMembers.length, waitingGuestNamesLabel]);

  const onLaunchHostRom = useCallback((): void => {
    if (!hostLaunchRoute) {
      setClipboardFeedback('Select a room ROM before launching.');
      return;
    }
    if (readyLaunchBlocked) {
      setClipboardFeedback('Ready lock is enabled. Wait for all connected players to mark ready.');
      return;
    }
    navigate(hostLaunchRoute);
  }, [hostLaunchRoute, navigate, readyLaunchBlocked, setClipboardFeedback]);

  useEffect(() => {
    if (!isHost) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (settingsModalOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          setSettingsModalOpen(false);
          return;
        }
        event.preventDefault();
        return;
      }

      if (wizardOpen) {
        event.preventDefault();
        return;
      }

      if (event.code === 'KeyG') {
        event.preventDefault();
        onLaunchHostRom();
        return;
      }

      if (event.shiftKey && event.code === 'KeyY') {
        event.preventDefault();
        onSendReadyCheck();
        return;
      }

      if (event.shiftKey && event.code === 'KeyP') {
        event.preventDefault();
        onPingWaitingPlayers();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isHost, onLaunchHostRom, onPingWaitingPlayers, onSendReadyCheck, settingsModalOpen, wizardOpen]);

  const onSendQuickChat = useCallback((message: string): void => {
    const sent = sendChatMessage(message);
    if (!sent) {
      return;
    }
    setChatAutoFollow(true);
    setChatNewWhileDetached(0);
  }, [sendChatMessage]);

  const onSendChat = (): void => {
    const sent = sendChatMessage(chatDraft, { clearDraft: true });
    if (!sent) {
      return;
    }
    setChatAutoFollow(true);
    setChatNewWhileDetached(0);
  };

  const onChatListScroll = useCallback((): void => {
    const list = chatListRef.current;
    if (!list) {
      return;
    }
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atBottom = distanceFromBottom <= 20;
    setChatAutoFollow(atBottom);
    if (atBottom) {
      setChatNewWhileDetached(0);
    }
  }, []);

  const onJumpToLatestChat = useCallback((): void => {
    const list = chatListRef.current;
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    }
    setChatAutoFollow(true);
    setChatNewWhileDetached(0);
    if (isHost) {
      setHostLastSeenChatCount(sessionChatCount);
    } else {
      setGuestLastSeenChatCount(sessionChatCount);
    }
  }, [isHost, sessionChatCount]);

  const onToggleReady = (): void => {
    if (!canSendRealtimeInput || !currentMember) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before updating ready state.');
      return;
    }

    const nextReady = !currentMemberReady;
    socket.send(
      JSON.stringify({
        type: 'set_ready',
        ready: nextReady,
      }),
    );

    setSession((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        members: current.members.map((member) =>
          member.clientId === clientId
            ? {
                ...member,
                ready: nextReady,
              }
            : member,
        ),
      };
    });

    setClipboardFeedback(nextReady ? 'Marked ready.' : 'Marked not ready.');
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

  const onToggleJoinLock = (): void => {
    if (!isHost) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before changing room lock.');
      return;
    }

    const nextLocked = !roomJoinLocked;
    socket.send(
      JSON.stringify({
        type: 'set_join_lock',
        locked: nextLocked,
      }),
    );

    setSession((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        joinLocked: nextLocked,
      };
    });
    setClipboardFeedback(nextLocked ? 'Room joins locked.' : 'Room joins unlocked.');
  };

  const onToggleSessionVoiceEnabled = (): void => {
    if (!isHost) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before changing voice settings.');
      return;
    }
    const nextEnabled = !session?.voiceEnabled;
    socket.send(
      JSON.stringify({
        type: 'set_voice_enabled',
        enabled: nextEnabled,
      }),
    );
    setSession((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        voiceEnabled: nextEnabled,
      };
    });
    setClipboardFeedback(nextEnabled ? 'Lobby voice enabled.' : 'Lobby voice disabled.');
  };

  const onGuestGameAudioVolumeChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const nextVolume = clampVolume(Number(event.target.value));
    setGuestGameAudioVolume(nextVolume);
  };

  const onGuestChatAudioVolumeChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const nextVolume = clampVolume(Number(event.target.value));
    setGuestChatAudioVolume(nextVolume);
  };

  const onToggleGuestGameAudioMuted = (): void => {
    if (!lobbyAudioMuted) {
      if (guestGameAudioVolume > 0.001) {
        guestGameVolumeBeforeMuteRef.current = guestGameAudioVolume;
      }
      setLobbyAudioMuted(true);
      return;
    }

    setLobbyAudioMuted(false);
    if (guestGameAudioVolume <= 0.001) {
      const restored = guestGameVolumeBeforeMuteRef.current;
      setGuestGameAudioVolume(clampVolume(restored > 0.001 ? restored : 1));
    }
  };

  const onToggleGuestChatAudioMuted = (): void => {
    if (guestChatAudioVolume > 0.001) {
      guestChatVolumeBeforeMuteRef.current = guestChatAudioVolume;
      setGuestChatAudioVolume(0);
      return;
    }
    const restored = guestChatVolumeBeforeMuteRef.current;
    setGuestChatAudioVolume(clampVolume(restored > 0.001 ? restored : 1));
  };

  const onToggleVoiceInputMuted = (): void => {
    if (isHost || !session?.voiceEnabled) {
      return;
    }
    if (voiceInputMuted) {
      setVoiceInputMuted(false);
      setVoiceMicError(undefined);
      return;
    }

    setVoiceInputMuted(true);
    const voiceTrack = guestVoiceLocalTrackRef.current;
    if (voiceTrack) {
      voiceTrack.enabled = false;
    }
    if (guestVoiceSenderRef.current) {
      void guestVoiceSenderRef.current.replaceTrack(null).catch(() => {
        // Ignore replacement failures and keep stream playback active.
      });
    }
  };

  const openCreateWizard = (): void => {
    setWizardMode('create');
    setWizardTemplateProfile(undefined);
    setWizardOpen(true);
  };

  const openEditWizard = (): void => {
    if (!activeProfile) {
      openCreateWizard();
      return;
    }
    setWizardMode('edit');
    setWizardTemplateProfile(undefined);
    setWizardOpen(true);
  };

  const openCloneWizard = (): void => {
    if (!activeProfile) {
      openCreateWizard();
      return;
    }
    setWizardMode('create');
    setWizardTemplateProfile(activeProfile);
    setWizardOpen(true);
  };

  const onActiveProfileSelect = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      setActiveProfile(event.target.value || undefined);
    },
    [setActiveProfile],
  );

  const onQuickSwapProfileSelect = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      onActiveProfileSelect(event);
      if (quickProfileSwitchRef.current) {
        quickProfileSwitchRef.current.open = false;
      }
    },
    [onActiveProfileSelect],
  );

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
    setWizardMode('create');
    setWizardTemplateProfile(undefined);
    setClipboardFeedback(`Saved controller profile "${profile.name}".`);
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

  const onKickMember = async (target: MultiplayerMember): Promise<void> => {
    if (!isHost || !normalizedCode || !clientId || target.isHost) {
      return;
    }

    const confirmed = window.confirm(`Kick ${target.name} (${slotLabel(target.slot)}) from this session?`);
    if (!confirmed) {
      return;
    }

    setKickingClientId(target.clientId);
    try {
      await kickOnlineMember({
        code: normalizedCode,
        clientId,
        targetClientId: target.clientId,
      });

      setSession((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          members: current.members.filter((member) => member.clientId !== target.clientId),
        };
      });
      setClipboardFeedback(`Removed ${target.name} from the session.`);
    } catch (kickError) {
      const message = kickError instanceof Error ? kickError.message : 'Failed to remove player.';
      setError(message);
    } finally {
      setKickingClientId(undefined);
    }
  };

  const onAssignMemberSlot = (target: MultiplayerMember, nextSlot: number): void => {
    if (!isHost || target.isHost || target.slot === nextSlot || nextSlot < 2 || nextSlot > 4) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before changing player slots.');
      return;
    }

    const occupant = session?.members.find((member) => member.slot === nextSlot && member.clientId !== target.clientId);

    setMovingSlotClientId(target.clientId);
    setMovingSlotTarget(nextSlot);
    socket.send(
      JSON.stringify({
        type: 'set_slot',
        targetClientId: target.clientId,
        slot: nextSlot,
      }),
    );

    setSession((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        members: current.members.map((member) => {
          if (member.clientId === target.clientId) {
            return {
              ...member,
              slot: nextSlot,
              ready: false,
            };
          }
          if (occupant && member.clientId === occupant.clientId) {
            return {
              ...member,
              slot: target.slot,
              ready: false,
            };
          }
          return member;
        }),
      };
    });

    if (occupant) {
      setClipboardFeedback(
        `Swapped ${target.name} (${slotLabel(target.slot)}) with ${occupant.name} (${slotLabel(nextSlot)}).`,
      );
    } else {
      setClipboardFeedback(`Moved ${target.name} to ${slotLabel(nextSlot)}.`);
    }
    setMovingSlotClientId(undefined);
    setMovingSlotTarget(undefined);
  };

  const onToggleMemberInputMute = (target: MultiplayerMember): void => {
    if (!isHost || target.isHost) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before changing input moderation.');
      return;
    }

    const currentlyMuted = mutedInputClientIdsSet.has(target.clientId);
    const nextMuted = !currentlyMuted;
    setMutingClientId(target.clientId);
    socket.send(
      JSON.stringify({
        type: 'set_input_mute',
        targetClientId: target.clientId,
        muted: nextMuted,
      }),
    );

    setSession((current) => {
      if (!current) {
        return current;
      }

      const mutedSet = new Set(current.mutedInputClientIds ?? []);
      if (nextMuted) {
        mutedSet.add(target.clientId);
      } else {
        mutedSet.delete(target.clientId);
      }
      return {
        ...current,
        mutedInputClientIds: [...mutedSet.values()],
      };
    });

    setClipboardFeedback(nextMuted ? `Muted ${target.name}'s input.` : `Unmuted ${target.name}'s input.`);
    setMutingClientId(undefined);
  };

  const setAllGuestInputMute = (muted: boolean): void => {
    if (!isHost) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setClipboardFeedback('Connect before changing input moderation.');
      return;
    }

    const targetGuests = hostGuestMembers.filter((member) =>
      muted ? !mutedInputClientIdsSet.has(member.clientId) : mutedInputClientIdsSet.has(member.clientId),
    );
    if (targetGuests.length === 0) {
      setClipboardFeedback(muted ? 'All guest input is already muted.' : 'All guest input is already unmuted.');
      return;
    }

    setMutingClientId(muted ? '__bulk_mute__' : '__bulk_unmute__');

    for (const member of targetGuests) {
      socket.send(
        JSON.stringify({
          type: 'set_input_mute',
          targetClientId: member.clientId,
          muted,
        }),
      );
    }

    setSession((current) => {
      if (!current) {
        return current;
      }

      const mutedSet = new Set(current.mutedInputClientIds ?? []);
      for (const member of targetGuests) {
        if (muted) {
          mutedSet.add(member.clientId);
        } else {
          mutedSet.delete(member.clientId);
        }
      }
      return {
        ...current,
        mutedInputClientIds: [...mutedSet.values()],
      };
    });

    setClipboardFeedback(
      muted
        ? `Muted input for ${targetGuests.length} guest${targetGuests.length === 1 ? '' : 's'}.`
        : `Unmuted input for ${targetGuests.length} guest${targetGuests.length === 1 ? '' : 's'}.`,
    );
    setMutingClientId(undefined);
  };

  const onMuteAllGuestInput = (): void => {
    setAllGuestInputMute(true);
  };

  const onUnmuteAllGuestInput = (): void => {
    setAllGuestInputMute(false);
  };

  const hostPrimaryQuickAction = (() => {
    if (socketStatus !== 'connected') {
      return {
        label: 'Reconnect',
        className: 'online-recovery-button',
        onClick: requestSocketReconnect,
        disabled: false,
        keepExpanded: true,
      } as const;
    }
    if (!session?.romId) {
      return {
        label: 'Pick ROM',
        className: 'online-rom-cta-button',
        onClick: onJumpToHostRomSetup,
        disabled: false,
        keepExpanded: true,
      } as const;
    }
    if (readyLaunchBlocked) {
      return {
        label: 'Ready Check',
        className: '',
        onClick: onSendReadyCheck,
        disabled: !canSendRealtimeInput || connectedHostGuestCount === 0,
        keepExpanded: true,
      } as const;
    }
    return {
      label: 'Launch ROM',
      className: 'preset-button',
      onClick: onLaunchHostRom,
      disabled: !session.romId,
      keepExpanded: false,
    } as const;
  })();

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
    <section
      className={`online-session-page ${
        !isHost && showVirtualController && !virtualControllerCollapsed ? 'online-session-has-virtual-controller' : ''
      } ${
        !isHost && showVirtualController && !virtualControllerCollapsed && virtualControllerMode === 'compact'
          ? 'online-session-virtual-compact'
          : ''
      } ${!isHost && showVirtualController && virtualControllerCollapsed ? 'online-session-virtual-collapsed' : ''} ${
        !isHost && guestStreamPriorityMode ? 'online-session-guest-stream-priority' : ''
      } ${!isHost && isCompactViewport ? 'online-session-guest-compact' : ''} ${
        !isHost && isPhoneViewport ? 'online-session-guest-phone' : ''
      } ${!isHost && guestFocusMode ? 'online-session-guest-focus' : ''} ${
        guestTwoColumnLayout ? 'online-session-guest-two-column' : ''
      }`}
    >
      <header className="panel">
        <h1>Online Session {normalizedCode}</h1>
        <div className="session-status-row">
          <span className={connectionClass(socketStatus)}>Connection: {socketStatus}</span>
          <span className={latencyClass(latencyMs, socketStatus === 'connected')}>
            Latency: {latencyMs ? `${latencyMs} ms` : socketStatus === 'connected' ? 'Measuring…' : 'Unavailable'}
          </span>
          <span className="status-pill">Players: {connectedPlayers}/4</span>
          {advancedSessionTools || isHost ? (
            <span className={roomJoinLocked ? 'status-pill status-warn' : 'status-pill status-good'}>
              Room: {roomJoinLocked ? 'Locked' : 'Open'}
            </span>
          ) : null}
          <span className={readyClass(everyoneConnectedReady, connectedPlayers > 0)}>
            Ready: {connectedReadyPlayers}/{connectedPlayers || 1}
          </span>
          <span className={session?.voiceEnabled ? 'status-pill status-good' : 'status-pill status-warn'}>
            Voice: {session?.voiceEnabled ? 'On' : 'Off'}
          </span>
          {advancedSessionTools || isHost ? (
            <span
              className={
                session?.romId
                  ? 'status-pill status-good'
                  : isHost
                    ? 'status-pill status-bad'
                    : 'status-pill status-warn'
              }
            >
              ROM: {session?.romId ? 'Selected' : 'Missing'}
            </span>
          ) : null}
          {showDetailedSessionStatus && latencySummary ? (
            <span className="status-pill">
              Relay avg: {latencySummary.averageMs}ms · p95: {latencySummary.p95Ms}ms
            </span>
          ) : null}
          {showDetailedSessionStatus && isHost ? (
            <span className={hostRelayHealthSummary.className}>Guest relay: {hostRelayHealthSummary.label}</span>
          ) : null}
          {showDetailedSessionStatus && latencyTrendSummary ? (
            <span className={latencyTrendSummary.className}>
              Latency {latencyTrendSummary.label} ({latencyTrendSummary.spreadMs}ms spread)
            </span>
          ) : null}
        </div>
        {showDetailedSessionStatus && latencyTrendSummary ? (
          <div className="online-latency-sparkline" aria-label="Recent latency trend">
            {latencyTrendSummary.bars.map((height, index) => (
              <span
                key={`latency-bar:${index}`}
                style={{ height: `${height}%` }}
                className={height > 76 ? 'online-latency-bar-hot' : undefined}
              />
            ))}
          </div>
        ) : null}
        {isPhoneViewport ? (
          <div className="online-session-details-summary">
            <span className="status-pill">{compactSessionSummary}</span>
            <button
              type="button"
              className="online-quickbar-toggle"
              onClick={() => setCompactSessionDetailsExpanded((value) => !value)}
              aria-expanded={showSessionDetails}
            >
              {showSessionDetails ? 'Hide Session Details' : 'Show Session Details'}
            </button>
          </div>
        ) : null}
        {isPhoneViewport && !showDetailedSessionStatus ? <p className="online-subtle">{compactStatusSummary}</p> : null}
        {showSessionDetails ? (
          <>
            {currentMember ? (
              <p>
                You are <strong>{slotLabel(currentMember.slot)}</strong>
                {isHost ? ' (Host)' : ''}
              </p>
            ) : (
              <p className="warning-text">Waiting for player assignment…</p>
            )}
            {session?.romTitle ? <p>Host ROM: {session.romTitle}</p> : <p>No host ROM selected yet.</p>}
            {isHost && !session?.romId ? (
              <div className="wizard-actions online-session-primary-cta">
                <button type="button" className="online-rom-cta-button" onClick={onJumpToHostRomSetup}>
                  Pick ROM Now
                </button>
              </div>
            ) : null}
            <div className="online-session-invite-line">
              <span>Invite code:</span>
              <button type="button" className="invite-code-pill" onClick={() => void onCopyInviteCode()}>
                {normalizedCode}
              </button>
            </div>
          </>
        ) : null}
        {currentMemberInputMuted ? (
          <p className="warning-text">Your controller input is currently muted by the host.</p>
        ) : null}
        {sessionClosedReason ? <p className="error-text">{sessionClosedReason}</p> : null}
        {isHost && showSessionDetails ? <p className="online-subtle">{hostRelayHealthSummary.detail}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        {clipboardMessage ? <p className="online-subtle">{clipboardMessage}</p> : null}
        <div
          className={`wizard-actions online-session-header-actions online-session-header-actions-primary ${
            isPhoneViewport ? 'online-session-header-actions-compact' : ''
          }`}
        >
          {socketStatus !== 'connected' ? (
            <button
              type="button"
              className="online-recovery-button"
              onClick={requestSocketReconnect}
              disabled={Boolean(sessionClosedReason)}
            >
              {socketStatus === 'connecting' ? 'Connecting…' : 'Reconnect'}
            </button>
          ) : null}
          <button type="button" onClick={() => void onCopyInviteCode()}>
            Copy Invite Code
          </button>
          <button type="button" onClick={() => setSettingsModalOpen(true)}>
            Settings
          </button>
          <button type="button" onClick={onToggleReady} disabled={!canSendRealtimeInput || !currentMember}>
            {currentMemberReady ? 'Mark Not Ready' : 'Mark Ready'}
          </button>
          {isHost && !session?.romId ? (
            <button type="button" className="online-rom-cta-button" onClick={onJumpToHostRomSetup}>
              Pick ROM
            </button>
          ) : null}
          {isHost ? (
            <button
              type="button"
              className={session?.voiceEnabled ? 'online-rom-cta-button' : undefined}
              onClick={onToggleSessionVoiceEnabled}
              disabled={!canSendRealtimeInput}
            >
              {session?.voiceEnabled ? 'Voice On' : 'Voice Off'}
            </button>
          ) : null}
          {isHost ? (
            <button type="button" className="danger-button" onClick={() => void onEndSession()} disabled={endingSession}>
              {endingSession ? 'Ending…' : 'End Session'}
            </button>
          ) : null}
          <Link to="/online">Back to Online</Link>
          <button
            type="button"
            className="online-quickbar-toggle online-session-more-actions-toggle"
            onClick={() => setSessionHeaderActionsExpanded((value) => !value)}
            aria-expanded={sessionHeaderActionsExpanded}
          >
            {sessionHeaderActionsExpanded ? 'Less Actions' : 'More Actions'}
          </button>
        </div>
        {sessionHeaderActionsExpanded ? (
          <div
            className={`wizard-actions online-session-header-actions online-session-header-actions-secondary ${
              isPhoneViewport ? 'online-session-header-actions-compact' : ''
            }`}
          >
            <button type="button" onClick={() => void onCopyInviteLink()} disabled={!inviteJoinUrl}>
              Copy Invite Link
            </button>
            {isHost ? (
              <button type="button" onClick={() => void onCopySessionRoomLink()} disabled={!sessionShareUrl}>
                Copy Room Link
              </button>
            ) : null}
            <button type="button" onClick={() => void refreshSessionSnapshot('manual')} disabled={refreshingSnapshot}>
              {refreshingSnapshot ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        ) : null}
        {!advancedSessionTools ? (
          <div className="online-simple-tools-note">
            <p className="online-subtle">
              Stream-first view is active. Core actions stay visible, and extra actions are tucked behind "More Actions".
            </p>
          </div>
        ) : null}
      </header>

      {!isHost && isPhoneViewport ? (
        <section
          className={`panel online-guest-quickbar ${guestQuickbarPinned ? 'online-quickbar-pinned' : 'online-quickbar-inline'}`}
          aria-label="Guest quick controls"
        >
          <div className="session-status-row online-quickbar-status-row" aria-label="Guest quick status">
            <span className={guestNetworkHealthStatus.className}>Network {guestNetworkHealthStatus.label}</span>
            <span className={guestPlaybackStatus.className}>Playback {guestPlaybackStatus.label}</span>
            {advancedSessionTools ? <span className="status-pill">Relay {guestInputRelayProfile.label}</span> : null}
            {advancedSessionTools && currentMemberInputMuted ? <span className="status-pill status-bad">Input muted</span> : null}
          </div>
          <div className="online-guest-quickbar-grid">
            <button type="button" onClick={() => setGuestFocusMode((value) => !value)} aria-pressed={guestFocusMode}>
              {guestFocusMode ? 'Disable Focus' : 'Enable Focus'}
            </button>
            <button type="button" onClick={onRequestHostStreamResync} disabled={!canSendRealtimeInput}>
              Re-sync Stream
            </button>
            <button
              type="button"
              onClick={() => setShowVirtualController((value) => !value)}
              aria-pressed={showVirtualController}
            >
              {showVirtualController ? 'Hide Virtual Pad' : 'Show Virtual Pad'}
            </button>
            <button
              type="button"
              className="online-quickbar-toggle"
              onClick={() => setGuestQuickbarExpanded((value) => !value)}
              aria-expanded={guestQuickbarExpanded}
            >
              {guestQuickbarExpanded ? 'Less Actions' : 'More Actions'}
            </button>
          </div>
          {guestQuickbarExpanded ? (
            <div className="online-guest-quickbar-grid online-quickbar-expanded-grid">
              <button type="button" onClick={() => setShowGuestInputDeck((value) => !value)} aria-pressed={showGuestInputDeck}>
                {showGuestInputDeck ? 'Hide Input Deck' : 'Show Input Deck'}
              </button>
              {guestRecoveryAction.key !== 'resync' ? (
                <button
                  type="button"
                  className="online-recovery-button"
                  onClick={guestRecoveryAction.onClick}
                  disabled={guestRecoveryAction.disabled}
                >
                  {guestRecoveryAction.label}
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="online-subtle">
            {guestQuickbarPinned ? 'Core controls stay pinned while scrolling.' : 'Core controls are inline.'}
            {guestUnreadChatCount > 0 ? ` Chat +${guestUnreadChatCount}.` : ''} Press <code>R</code> to re-sync if video stalls.
          </p>
          {advancedSessionTools && guestQuickbarExpanded ? (
            <p className="online-subtle online-quickbar-guidance">{guestSuggestedActionText}</p>
          ) : null}
        </section>
      ) : null}

      {isHost && isPhoneViewport ? (
        <section
          className={`panel online-host-quickbar ${hostQuickbarPinned ? 'online-quickbar-pinned' : 'online-quickbar-inline'}`}
          aria-label="Host quick controls"
        >
          <div className="session-status-row online-quickbar-status-row" aria-label="Host quick status">
            <span className={hostRelayHealthSummary.className}>Guest relay {hostRelayHealthSummary.label}</span>
            <span className={readyClass(everyoneConnectedReady, connectedPlayers > 0)}>
              Ready {connectedReadyPlayers}/{connectedPlayers || 1}
            </span>
            <span className={hostLaunchReady ? 'status-pill status-good' : session?.romId ? 'status-pill status-warn' : 'status-pill status-bad'}>
              {hostLaunchReady ? 'Launch Ready' : session?.romId ? 'Launch Waiting' : 'ROM Missing'}
            </span>
            {advancedSessionTools && mutedGuestCount > 0 ? <span className="status-pill status-warn">Muted {mutedGuestCount}</span> : null}
          </div>
          <div className="online-guest-quickbar-grid">
            <button
              type="button"
              className={hostPrimaryQuickAction.className}
              onClick={() => runHostQuickAction(hostPrimaryQuickAction.onClick, { keepExpanded: hostPrimaryQuickAction.keepExpanded })}
              disabled={hostPrimaryQuickAction.disabled}
            >
              {hostPrimaryQuickAction.label}
            </button>
            <button type="button" onClick={() => setHostPlayersCollapsed((value) => !value)} aria-pressed={!hostPlayersCollapsed}>
              {hostPlayersCollapsed ? 'Show Players' : 'Hide Players'}
            </button>
            <button type="button" onClick={() => setHostControlsCollapsed((value) => !value)} aria-pressed={!hostControlsCollapsed}>
              {hostControlsCollapsed ? 'Show Controls' : 'Hide Controls'}
            </button>
            <button
              type="button"
              className="online-quickbar-toggle"
              onClick={() => setHostQuickbarExpanded((value) => !value)}
              aria-expanded={hostQuickbarExpanded}
            >
              {hostQuickbarExpanded ? 'Less Actions' : 'More Actions'}
            </button>
          </div>
          {hostQuickbarExpanded ? (
            <div className="online-guest-quickbar-grid online-quickbar-expanded-grid">
              <button type="button" onClick={() => setHostChatCollapsed((value) => !value)} aria-pressed={!hostChatCollapsed}>
                {hostChatCollapsed ? `Show Chat${hostUnreadChatCount > 0 ? ` (+${hostUnreadChatCount})` : ''}` : 'Hide Chat'}
              </button>
              <button type="button" onClick={() => void onCopySessionRoomLink()} disabled={!sessionShareUrl}>
                Copy Room Link
              </button>
            </div>
          ) : null}
          <p className="online-subtle">
            Core host controls stay available while detailed panels are collapsed.
            {hostUnreadChatCount > 0 ? ` Chat +${hostUnreadChatCount}.` : ''}
            {hostUnreadRemoteInputCount > 0 ? ` Feed +${hostUnreadRemoteInputCount}.` : ''}
            <code>G</code> launches.
          </p>
          {advancedSessionTools ? <p className="online-subtle online-quickbar-guidance">{hostQuickActionHint}</p> : null}
        </section>
      ) : null}

      {showGuestSecondaryPanels ? (
        <section ref={playersPanelRef} className="panel online-session-players-panel">
          <div className="panel-header-inline">
            <h2>Players</h2>
            {isCompactViewport ? (
              <button
                type="button"
                onClick={() =>
                  isHost
                    ? setHostPlayersCollapsed((value) => !value)
                    : toggleGuestPlayersPanel()
                }
                aria-pressed={!playersPanelCollapsed}
              >
                {playersPanelCollapsed ? 'Show Players' : 'Hide Players'}
              </button>
            ) : null}
          </div>
          {isCompactViewport && playersPanelCollapsed ? (
            <p className="online-subtle">
              {isHost
                ? 'Players panel collapsed to keep host controls in focus.'
                : 'Players panel collapsed for stream focus.'}
            </p>
          ) : (
            <>
              <ul className="room-player-list">
                {[1, 2, 3, 4].map((slot) => {
                  const member = membersBySlot.get(slot);
                  return (
                    <li key={slot}>
                      <div className="room-player-row">
                        <span className="room-player-identity">
                          <SessionMemberAvatar member={member} />
                          <span>
                            <strong>{slotLabel(slot)}:</strong>{' '}
                            {member ? `${member.name}${member.isHost ? ' (Host)' : ''}` : 'Open slot'}
                            {member ? ` • ${member.connected ? 'connected' : 'disconnected'}` : ''}
                            {member && member.connected ? ` • ${member.ready ? 'ready' : 'waiting'}` : ''}
                            {member && member.connected && typeof member.pingMs === 'number' ? ' • ' : ''}
                            {member && member.connected && typeof member.pingMs === 'number' ? (
                              <span className={relayPingClass(member.pingMs, member.connected)}>{member.pingMs}ms relay</span>
                            ) : null}
                            {member && mutedInputClientIdsSet.has(member.clientId) ? ' • input muted' : ''}
                          </span>
                        </span>
                        {isHost && member && !member.isHost ? (
                          <div className="room-player-actions">
                            <div className="slot-move-actions" aria-label={`Move ${member.name} to a player slot`}>
                              {[2, 3, 4].map((targetSlot) => {
                                const targetSlotMember = session?.members.find(
                                  (sessionMember) =>
                                    sessionMember.slot === targetSlot && sessionMember.clientId !== member.clientId,
                                );
                                const isCurrentSlot = member.slot === targetSlot;
                                const isMovingToSlot =
                                  movingSlotClientId === member.clientId && movingSlotTarget === targetSlot;
                                return (
                                  <button
                                    key={`${member.clientId}:${targetSlot}`}
                                    type="button"
                                    className={`slot-move-button ${isCurrentSlot ? 'active' : ''}`}
                                    onClick={() => onAssignMemberSlot(member, targetSlot)}
                                    disabled={!canSendRealtimeInput || Boolean(movingSlotClientId) || isCurrentSlot}
                                  >
                                    {isMovingToSlot
                                      ? 'Moving…'
                                      : targetSlotMember
                                        ? `Swap P${targetSlot}`
                                        : `Move to P${targetSlot}`}
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              type="button"
                              onClick={() => onToggleMemberInputMute(member)}
                              disabled={
                                Boolean(kickingClientId) || Boolean(movingSlotClientId) || Boolean(mutingClientId)
                              }
                            >
                              {mutingClientId === member.clientId
                                ? 'Updating…'
                                : mutedInputClientIdsSet.has(member.clientId)
                                  ? 'Unmute Input'
                                  : 'Mute Input'}
                            </button>
                            <button
                              type="button"
                              className="danger-button inline-danger-button"
                              onClick={() => void onKickMember(member)}
                              disabled={
                                Boolean(kickingClientId) || Boolean(movingSlotClientId) || Boolean(mutingClientId)
                              }
                            >
                              {kickingClientId === member.clientId ? 'Removing…' : 'Kick'}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {isHost && hostGuestMembers.length > 0 ? (
                <div className="online-player-moderation">
                  <p className="online-subtle">
                    Input moderation: {mutedGuestCount}/{hostGuestMembers.length} guest
                    {hostGuestMembers.length === 1 ? '' : 's'} muted.
                  </p>
                  <div className="wizard-actions">
                    <button
                      type="button"
                      onClick={onMuteAllGuestInput}
                      disabled={
                        !canSendRealtimeInput ||
                        mutedGuestCount === hostGuestMembers.length ||
                        Boolean(kickingClientId) ||
                        Boolean(movingSlotClientId) ||
                        Boolean(mutingClientId)
                      }
                    >
                      Mute All Guests
                    </button>
                    <button
                      type="button"
                      onClick={onUnmuteAllGuestInput}
                      disabled={
                        !canSendRealtimeInput ||
                        mutedGuestCount === 0 ||
                        Boolean(kickingClientId) ||
                        Boolean(movingSlotClientId) ||
                        Boolean(mutingClientId)
                      }
                    >
                      Unmute All Guests
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section
        ref={guestStreamPanelRef}
        className={`panel online-guest-stream-panel ${!isHost && guestFocusMode ? 'focus' : ''} ${
          !isHost && guestStreamPriorityMode ? 'online-guest-stream-priority' : ''
        } ${!isHost && showGuestDiagnosticsPanel ? 'online-guest-diagnostics-expanded' : 'online-guest-diagnostics-compact'} ${
          isHost ? 'online-host-stream-panel' : ''
        }`}
      >
        <div className={`online-guest-stage ${!isHost && guestFocusMode ? 'online-guest-stage-focus' : ''}`}>
          <div className="play-overlay-top online-guest-stage-top">
            <div className="play-overlay-left">
              <button
                type="button"
                className="play-menu-toggle"
                onClick={() =>
                  isHost ? setHostControlsCollapsed((value) => !value) : setGuestFocusMode((value) => !value)
                }
              >
                {isHost
                  ? hostControlsCollapsed
                    ? 'Show Host Tools'
                    : 'Hide Host Tools'
                  : guestFocusMode
                    ? 'Disable Focus Mode'
                    : 'Enable Focus Mode'}
              </button>
              <div className="play-overlay-meta">
                <h2>Host Stream</h2>
                <p>
                  {isHost
                    ? session?.romId
                      ? 'Host Mode • Ready to launch'
                      : 'Host Mode • Pick a room ROM'
                    : `${hostStreamStatus === 'live' ? 'Live' : hostStreamStatus === 'connecting' ? 'Connecting' : 'Waiting'} • Remote Play`}
                </p>
              </div>
            </div>
            <div className="play-overlay-actions online-guest-stream-actions">
              {isHost ? (
                <>
                  <button type="button" className="preset-button" onClick={onLaunchHostRom} disabled={!session?.romId}>
                    Launch ROM
                  </button>
                  <button type="button" onClick={onToggleSessionVoiceEnabled} disabled={!canSendRealtimeInput}>
                    {session?.voiceEnabled ? 'Disable Voice Chat' : 'Enable Voice Chat'}
                  </button>
                  <button type="button" onClick={() => setHostControlsCollapsed((value) => !value)}>
                    {hostControlsCollapsed ? 'Show Host Tools' : 'Hide Host Tools'}
                  </button>
                  <button type="button" onClick={() => void onToggleGuestStreamFullscreen()}>
                    {isGuestStreamFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                  </button>
                </>
              ) : (
                <>
                  {session?.voiceEnabled ? (
                    <button
                      type="button"
                      className={voiceInputMuted ? 'online-voice-join-button' : undefined}
                      onClick={onToggleVoiceInputMuted}
                      title={voiceInputMuted ? VOICE_JOIN_TOOLTIP : undefined}
                      disabled={voiceMicRequesting}
                    >
                      {voiceMicRequesting
                        ? 'Preparing Mic…'
                        : voiceInputMuted
                          ? 'Unmute to Talk'
                          : 'Mute Mic'}
                    </button>
                  ) : (
                    <button type="button" disabled>
                      Voice Chat Off
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onToggleGuestGameAudioMuted}
                    disabled={hostStreamStatus !== 'live'}
                  >
                    {lobbyAudioMuted ? 'Unmute Game Audio' : 'Mute Game Audio'}
                  </button>
                  <button
                    type="button"
                    onClick={onToggleGuestChatAudioMuted}
                    disabled={hostStreamStatus !== 'live'}
                  >
                    {guestChatAudioVolume <= 0.001 ? 'Unmute Chat Audio' : 'Mute Chat Audio'}
                  </button>
                  <button type="button" onClick={onRequestHostStreamResync} disabled={!canSendRealtimeInput}>
                    Re-sync Stream
                  </button>
                  <button type="button" onClick={() => void onToggleGuestStreamFullscreen()}>
                    {isGuestStreamFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="play-stage-surface online-guest-stage-surface">
            <div
              ref={hostStreamShellRef}
              className={`host-stream-shell ejs-player-host ejs-player-host-focus ${
                !isHost && guestFocusMode ? 'host-stream-shell-focus' : ''
              }`}
            >
              <video
                ref={hostStreamVideoRef}
                className="host-stream-video"
                autoPlay
                playsInline
                muted={lobbyAudioMuted}
                controls={false}
                disablePictureInPicture
                disableRemotePlayback
              />
              {(isHost || hostStreamPlaceholderTitle) ? (
                <div className="host-stream-placeholder">
                  <strong>
                    {isHost
                      ? session?.romId
                        ? 'Launch gameplay to start stream'
                        : 'Choose a room ROM'
                      : hostStreamPlaceholderTitle}
                  </strong>
                  <span>
                    {isHost
                      ? session?.romId
                        ? 'Start the ROM from this room or gameplay view and guests will receive your stream.'
                        : 'Open Host Tools to choose a ROM for this room.'
                      : hostStreamPlaceholderHint}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="play-overlay-bottom online-guest-stage-bottom">
            {showGuestDiagnosticsPanel && !isHost ? (
              <div className="session-status-row host-stream-telemetry-row">
                <span className={guestNetworkHealthStatus.className}>Network: {guestNetworkHealthStatus.label}</span>
                <span className={guestPlaybackStatus.className}>Playback: {guestPlaybackStatus.label}</span>
                <span className="status-pill">Input relay: {guestInputRelayProfile.label}</span>
                <span className="status-pill">
                  Bitrate: {guestStreamTelemetry.bitrateKbps !== undefined ? `${guestStreamTelemetry.bitrateKbps} kbps` : 'Measuring…'}
                </span>
                <span className="status-pill">
                  FPS: {guestStreamTelemetry.fps !== undefined ? guestStreamTelemetry.fps.toFixed(1) : 'Measuring…'}
                </span>
              </div>
            ) : null}
            <p className="online-subtle">
              {isHost
                ? session?.romId
                  ? `Room ROM ready: ${session.romTitle ?? 'selected ROM'}. Launch when everyone is ready.`
                  : 'No room ROM selected. Open Host Tools to pick a game.'
                : hostStreamStatusText}
            </p>
            {isHost ? (
              <>
                {hostLaunchBlockedReason ? <p className="warning-text">{hostLaunchBlockedReason}</p> : null}
                <p className="online-subtle">{hostQuickActionHint}</p>
                <p className="online-subtle">
                  Host extras are tucked under Host Tools to keep this gameplay layout aligned with guest view.
                </p>
              </>
            ) : (
              <>
                <div className="online-audio-mix-controls">
                  <label htmlFor="guest-game-volume-slider">
                    Game audio volume ({volumePercentLabel(guestGameAudioVolume)})
                  </label>
                  <input
                    id="guest-game-volume-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={guestGameAudioVolume}
                    onChange={onGuestGameAudioVolumeChange}
                  />
                  <label htmlFor="guest-chat-volume-slider">
                    Chat audio volume ({volumePercentLabel(guestChatAudioVolume)})
                  </label>
                  <input
                    id="guest-chat-volume-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={guestChatAudioVolume}
                    onChange={onGuestChatAudioVolumeChange}
                  />
                </div>
                {showGuestRescueCard ? (
                  <div className="stream-quality-request-card online-rescue-card">
                    <p>
                      <strong>Stream needs recovery.</strong> Run rescue first, then request a stream resync if delay remains high.
                    </p>
                    <div className="wizard-actions">
                      <button type="button" className="latency-rescue-button" onClick={onLatencyRescue}>
                        Run Rescue
                      </button>
                      <button type="button" onClick={onRequestHostStreamResync} disabled={!canSendRealtimeInput}>
                        Resync Now
                      </button>
                    </div>
                  </div>
                ) : null}
                {session?.voiceEnabled ? (
                  <p className={voiceInputMuted ? 'online-subtle online-voice-join-hint' : 'online-subtle'}>
                    {voiceInputMuted
                      ? VOICE_JOIN_TOOLTIP
                      : 'Microphone is live. Click "Mute Mic" any time to leave conversation.'}
                  </p>
                ) : (
                  <p className="online-subtle">Host has voice chat disabled for this room.</p>
                )}
                {voiceMicError ? <p className="warning-text">{voiceMicError}</p> : null}
                <p className="online-subtle">{guestPlaybackStatus.detail}</p>
                {advancedSessionTools ? <p className="online-subtle">{guestNetworkHealthStatus.recommendation}</p> : null}
                {advancedSessionTools ? (
                  <p className="online-subtle">
                    Suggested host stream mode: {HOST_STREAM_PRESET_LABELS[suggestedHostPresetForGuest]}.
                  </p>
                ) : null}
                {profiles.length > 0 ? (
                  <details ref={quickProfileSwitchRef} className="play-profile-quick-switch">
                    <summary>
                      <span className="play-profile-quick-switch-summary-label">Applied controller profile:</span>
                      <span className="play-profile-quick-switch-summary-value">{activeProfileSummaryLabel}</span>
                      <span className="play-profile-quick-switch-summary-hint">Quick swap</span>
                    </summary>
                    <div className="play-profile-quick-switch-panel">
                      <label htmlFor="online-overlay-profile-switcher">Quick swap profile</label>
                      <select
                        id="online-overlay-profile-switcher"
                        value={activeProfileId ?? ''}
                        onChange={onQuickSwapProfileSelect}
                      >
                        <option value="">None</option>
                        {profiles.map((profile) => (
                          <option key={profile.profileId} value={profile.profileId}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </details>
                ) : (
                  <p>Applied controller profile: {activeProfileSummaryLabel}</p>
                )}
              </>
            )}
          </div>
        </div>

        {!isHost ? (
          showGuestInputDeck ? (
            <>
              <h3 ref={guestInputDeckRef}>Controller Profile</h3>
              {profiles.length > 0 ? (
                <label>
                  Active profile
                  <select value={activeProfileId ?? ''} onChange={onActiveProfileSelect}>
                    <option value="">None</option>
                    {profiles.map((profile) => (
                      <option key={profile.profileId} value={profile.profileId}>
                        {profile.name}
                        {profile.romHash ? ' (ROM-specific)' : ' (Global)'}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="online-subtle">No controller profiles yet.</p>
              )}
              <div className="wizard-actions">
                <button type="button" onClick={openCreateWizard}>
                  New Profile
                </button>
                <button type="button" onClick={openEditWizard} disabled={!activeProfile}>
                  Edit Active
                </button>
                <button type="button" onClick={openCloneWizard} disabled={!activeProfile}>
                  Clone Active
                </button>
              </div>

              <h3>Send Controller Input</h3>
              <p>Use your active profile, quick taps, or virtual controller to drive the host emulator in real time.</p>
              <p className="online-subtle">
                Keyboard: <code>X</code> A, <code>C</code> B, <code>Z</code> Z, <code>Enter</code> Start, arrows D-Pad,
                <code> Q/E</code> L/R, <code>I/J/K/L</code> C-buttons.
              </p>
              <p className="online-subtle">
                Gamepad: ABXZ, Start, shoulders, and D-Pad are captured automatically.
                {gamepadConnected ? ' Gamepad connected.' : ' Connect a gamepad to enable capture.'}
              </p>
              <p className="online-subtle">
                Analog stick movement is streamed with variable intensity for smoother remote control.
              </p>
              <p className="online-subtle">
                Relay mode is optimized automatically ({guestInputRelayProfile.label}) for lower input delay and steadier stream sync.
              </p>
              <p className="online-subtle">
                Smart recovery stays enabled in the background to re-sync if playback freezes.
              </p>
              {currentMemberInputMuted ? (
                <p className="warning-text">Host muted your controller input. Input controls are temporarily disabled.</p>
              ) : null}
              <div className="online-input-grid">
                {QUICK_INPUTS.map((entry) => (
                  <button
                    key={entry.label}
                    type="button"
                    className={activeQuickHoldControls.includes(entry.control) ? 'online-input-active' : undefined}
                    onPointerDown={(event) => onQuickInputPointerDown(entry.control, event)}
                    onPointerUp={() => releaseHeldQuickControl(entry.control)}
                    onPointerCancel={() => releaseHeldQuickControl(entry.control)}
                    onPointerLeave={() => releaseHeldQuickControl(entry.control)}
                    onClick={() => onQuickInputClick(entry.control)}
                    disabled={!canSendGuestControllerInput}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="online-subtle">
              Input deck is hidden for stream focus. Press <code>I</code> or click "Show Input Deck" to restore controls.
            </p>
          )
        ) : (
          <p className="online-subtle">Host input mapping and gameplay controls appear after you launch the ROM.</p>
        )}
      </section>

      {isHost ? (
        <section ref={hostControlsPanelRef} className="panel online-session-host-controls-panel">
          <div className="panel-header-inline">
            <h2>Host Tools</h2>
            <button type="button" onClick={() => setHostControlsCollapsed((value) => !value)}>
              {hostControlsCollapsed ? 'Show Host Tools' : 'Hide Host Tools'}
            </button>
          </div>
          {hostControlsCollapsed ? (
            <p className="online-subtle">Host tools are hidden. Open this panel for room management, launch setup, and diagnostics.</p>
          ) : (
            <>
              <p>Share code <strong>{normalizedCode}</strong> or your invite link to have friends join instantly.</p>
              <p className={roomJoinLocked ? 'warning-text' : 'online-subtle'}>
                Join access: {roomJoinLocked ? 'Locked to current players' : 'Open for invited players'}.
              </p>
              <div className="wizard-actions">
                <button type="button" onClick={onToggleJoinLock} disabled={!canSendRealtimeInput}>
                  {roomJoinLocked ? 'Unlock Room Joins' : 'Lock Room Joins'}
                </button>
              </div>
              <h3>Lobby Voice</h3>
              <p className="online-subtle">
                Voice chat is {session?.voiceEnabled ? 'enabled' : 'disabled'}. Guests can only unmute when enabled.
              </p>
              <div className="wizard-actions">
                <button type="button" onClick={onToggleSessionVoiceEnabled} disabled={!canSendRealtimeInput}>
                  {session?.voiceEnabled ? 'Disable Voice Chat' : 'Enable Voice Chat'}
                </button>
              </div>
              {connectedPlayers > 1 ? (
                <p className={everyoneConnectedReady ? 'online-ready-banner' : 'online-subtle'}>
                  Ready check: {connectedReadyPlayers}/{connectedPlayers} connected players ready
                  {everyoneConnectedReady ? ' • Everyone is synced to launch.' : ' • Waiting on remaining players.'}
                </p>
              ) : null}
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
              <div className="online-launch-readiness-card">
                <div className="panel-header-inline">
                  <h3>Launch</h3>
                  <span
                    className={
                      hostLaunchReady ? 'status-pill status-good' : session?.romId ? 'status-pill status-warn' : 'status-pill status-bad'
                    }
                  >
                    {hostLaunchReady ? 'Ready to Launch' : session?.romId ? 'Waiting on Players' : 'ROM Required'}
                  </span>
                </div>
                <p className="online-subtle">
                  {session?.romId
                    ? `${session.romTitle ?? 'Room ROM'} is selected.`
                    : 'Select a room ROM to launch multiplayer gameplay.'}{' '}
                  Connected guests: {connectedHostGuestCount}.
                </p>
                {!session?.romId ? (
                  <p className="online-subtle">
                    No ROM selected for host yet. <Link to={libraryRoute}>Choose ROM in Library</Link>.
                  </p>
                ) : null}
                {hostLaunchBlockedReason ? <p className="warning-text">{hostLaunchBlockedReason}</p> : null}
                <div className="wizard-actions online-launch-actions">
                  <button type="button" onClick={onLaunchHostRom} disabled={!session?.romId}>
                    Launch Host ROM
                  </button>
                  <button type="button" onClick={() => setShowHostLaunchOptions((value) => !value)}>
                    {showHostLaunchOptions ? 'Hide Launch Options' : 'More Launch Options'}
                  </button>
                  {showHostLaunchOptions ? (
                    <button type="button" onClick={onSendReadyCheck} disabled={!canSendRealtimeInput || connectedHostGuestCount === 0}>
                      Send Ready Check
                    </button>
                  ) : null}
                  {showHostLaunchOptions ? (
                    <button
                      type="button"
                      onClick={onPingWaitingPlayers}
                      disabled={!canSendRealtimeInput || waitingGuestMembers.length === 0}
                    >
                      Ping Waiting Guests
                    </button>
                  ) : null}
                </div>
                {showHostLaunchOptions ? (
                  <>
                    <ul className="online-launch-checklist">
                      <li className={session?.romId ? 'launch-check-pass' : 'launch-check-blocked'}>
                        <strong>ROM</strong> {session?.romId ? `selected: ${session.romTitle ?? 'Room ROM ready'}` : 'not selected yet'}
                      </li>
                      <li className={connectedHostGuestCount > 0 ? 'launch-check-pass' : 'launch-check-blocked'}>
                        <strong>Guests</strong>{' '}
                        {connectedHostGuestCount > 0
                          ? `${connectedHostGuestCount} connected`
                          : 'none connected yet'}
                      </li>
                      <li className={readyLaunchBlocked ? 'launch-check-blocked' : 'launch-check-pass'}>
                        <strong>Ready lock</strong>{' '}
                        {enforceReadyBeforeLaunch
                          ? readyLaunchBlocked
                            ? `${launchWaitingCount} player${launchWaitingCount === 1 ? '' : 's'} still not ready`
                            : 'all connected players are ready'
                          : 'disabled'}
                      </li>
                    </ul>
                    {waitingGuestMembers.length > 0 ? (
                      <>
                        <p className="online-subtle">Waiting guests</p>
                        <div className="online-waiting-guests">
                          {waitingGuestMembers.map((member) => (
                            <span key={member.clientId} className="status-pill status-warn">
                              {member.name}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : null}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={enforceReadyBeforeLaunch}
                        onChange={(event) => setEnforceReadyBeforeLaunch(event.target.checked)}
                      />
                      Require all connected players ready before launch
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoLaunchWhenReady}
                        onChange={(event) => setAutoLaunchWhenReady(event.target.checked)}
                      />
                      Auto-launch host ROM when everyone is ready
                    </label>
                    {readyLaunchBlocked ? (
                      <p className="warning-text">
                        Ready lock active: waiting on {connectedPlayers - connectedReadyPlayers} player
                        {connectedPlayers - connectedReadyPlayers === 1 ? '' : 's'}.
                      </p>
                    ) : null}
                    {autoLaunchWhenReady ? (
                      <p className={autoLaunchEligible ? 'online-ready-banner' : 'online-subtle'}>
                        {autoLaunchEligible && readyAutoLaunchCountdown !== null
                          ? `Auto-launching in ${readyAutoLaunchCountdown}s. Keep this tab active to host gameplay.`
                          : session?.romId
                            ? 'Auto-launch armed. Gameplay starts automatically once all connected players are ready.'
                            : 'Auto-launch armed. Select a room ROM first to enable launch countdown.'}
                      </p>
                    ) : null}
                    {autoLaunchWhenReady ? (
                      <div className="wizard-actions online-autolaunch-actions">
                        <button type="button" onClick={() => setAutoLaunchWhenReady(false)}>
                          Cancel Auto-launch
                        </button>
                      </div>
                    ) : null}
                    <p className="online-subtle">
                      Shortcuts: <code>G</code> launch • <code>Shift+Y</code> ready check • <code>Shift+P</code> ping waiting.
                    </p>
                  </>
                ) : (
                  <p className="online-subtle">
                    Keep this view simple: launch ROM when ready. Use “More Launch Options” for ready-check and auto-launch tools.
                  </p>
                )}
              </div>
              {advancedSessionTools && sessionRoute ? (
                <div className="online-session-route-note">
                  <p className="online-subtle">
                    Returning from Play keeps this room active. Save this room link so you can reopen in host mode.
                  </p>
                  <div className="wizard-actions online-inline-actions">
                    <button type="button" onClick={() => void onCopySessionRoomLink()} disabled={!sessionShareUrl}>
                      Copy Room Link
                    </button>
                  </div>
                </div>
              ) : null}
              {advancedSessionTools ? (
                <>
                  <div className="panel-header-inline">
                    <h3>Remote Input Feed</h3>
                    <div className="wizard-actions online-inline-actions">
                      <button type="button" onClick={toggleHostRemoteFeedPanel}>
                        {hostRemoteFeedCollapsed
                          ? `Show Feed${hostUnreadRemoteInputCount > 0 ? ` (+${hostUnreadRemoteInputCount})` : ''}`
                          : 'Hide Feed'}
                      </button>
                      <button type="button" onClick={() => setHostRemoteFeedPaused((value) => !value)}>
                        {hostRemoteFeedPaused ? 'Resume Feed' : 'Pause Feed'}
                        {hostRemoteFeedBufferedCount > 0 ? ` (+${hostRemoteFeedBufferedCount})` : ''}
                      </button>
                      <button type="button" onClick={() => void onCopyRemoteFeed()} disabled={filteredRemoteInputs.length === 0}>
                        Copy Feed
                      </button>
                      <button type="button" onClick={() => void onCopyHostDiagnostics()}>
                        Copy Diagnostics
                      </button>
                      {!hostRemoteFeedCollapsed && (hostRemoteFeedDetachedCount > 0 || !hostRemoteFeedAutoFollow) ? (
                        <button type="button" onClick={onJumpToLatestRemoteFeed}>
                          Jump Latest{hostRemoteFeedDetachedCount > 0 ? ` (+${hostRemoteFeedDetachedCount})` : ''}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setRemoteInputs([]);
                          bufferedRemoteInputsRef.current = [];
                          setHostRemoteFeedBufferedCount(0);
                          setHostRemoteFeedDetachedCount(0);
                          setClipboardFeedback('Cleared remote input feed.');
                        }}
                        disabled={remoteInputs.length === 0}
                      >
                        Clear Feed
                      </button>
                    </div>
                  </div>
                  {hostRemoteFeedCollapsed ? (
                    <p className="online-subtle">Remote input feed is hidden. Expand to inspect live button and analog events.</p>
                  ) : (
                    <>
                      <div className="session-status-row online-remote-feed-status-row">
                        <span className="status-pill">Visible {filteredRemoteInputs.length}</span>
                        <span className="status-pill">Analog {remoteFeedSummary.analog}</span>
                        <span className="status-pill">Digital {remoteFeedSummary.digital}</span>
                        {remoteFeedSummary.unknown > 0 ? <span className="status-pill status-warn">Unknown {remoteFeedSummary.unknown}</span> : null}
                        {hostRemoteFeedPaused ? <span className="status-pill status-warn">Paused</span> : null}
                      </div>
                      <div className="wizard-actions online-remote-feed-filters">
                        <label>
                          Type
                          <select
                            value={hostRemoteFeedFilterKind}
                            onChange={(event) => setHostRemoteFeedFilterKind(event.target.value as HostRemoteFeedFilterKind)}
                          >
                            <option value="all">All events</option>
                            <option value="digital">Digital only</option>
                            <option value="analog">Analog only</option>
                            <option value="unknown">Unknown only</option>
                          </select>
                        </label>
                        <label>
                          Slot
                          <select
                            value={hostRemoteFeedFilterSlot}
                            onChange={(event) =>
                              setHostRemoteFeedFilterSlot(
                                event.target.value === 'all' ? 'all' : (Number(event.target.value) as HostRemoteFeedSlotFilter),
                              )
                            }
                          >
                            <option value="all">All players</option>
                            <option value="2">Player 2</option>
                            <option value="3">Player 3</option>
                            <option value="4">Player 4</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setHostRemoteFeedFilterKind('all');
                            setHostRemoteFeedFilterSlot('all');
                            setHostRemoteFeedAutoFollow(true);
                            setHostRemoteFeedDetachedCount(0);
                          }}
                        >
                          Reset Feed View
                        </button>
                      </div>
                      <p className="online-subtle">
                        Tip: pause feed during heavy analog bursts, then resume to apply buffered events without losing input history.
                      </p>
                      {filteredRemoteInputs.length === 0 ? <p>No remote input events in this view yet.</p> : null}
                      <ul ref={remoteFeedListRef} className="remote-input-list" onScroll={onRemoteFeedScroll}>
                        {filteredRemoteInputs.map((event, index) => (
                          <li
                            key={`${event.at}:${index}`}
                            className={
                              event.payload?.kind === 'analog'
                                ? 'remote-input-analog'
                                : event.payload?.pressed
                                  ? 'remote-input-down'
                                  : 'remote-input-up'
                            }
                          >
                            {new Date(event.at).toLocaleTimeString()} • {slotLabel(event.fromSlot)} ({event.fromName}) •{' '}
                            <code>{describeRemoteInputPayload(event.payload)}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p className="online-subtle">
                  Remote input diagnostics are hidden in Simple view. Enable Advanced Tools when you need feed inspection.
                </p>
              )}
            </>
          )}
        </section>
      ) : null}

      {showGuestSecondaryPanels ? (
        <section ref={chatPanelRef} className="panel online-session-chat-panel">
          <div className="panel-header-inline">
            <h2>Session Chat</h2>
            <div className="online-chat-header-actions">
              {!chatPanelCollapsed ? (
                <button type="button" onClick={onFocusChatComposer}>
                  Focus Input
                </button>
              ) : null}
              {!chatPanelCollapsed && (chatNewWhileDetached > 0 || !chatAutoFollow) ? (
                <button type="button" onClick={onJumpToLatestChat}>
                  Jump to Latest{chatNewWhileDetached > 0 ? ` (+${chatNewWhileDetached})` : ''}
                </button>
              ) : null}
              {isCompactViewport ? (
                <button
                  type="button"
                  onClick={() => (isHost ? setHostChatCollapsed((value) => !value) : toggleGuestChatPanel())}
                  aria-pressed={!chatPanelCollapsed}
                >
                  {chatPanelCollapsed ? `Show Chat${unreadChatCount > 0 ? ` (${unreadChatCount} new)` : ''}` : 'Hide Chat'}
                </button>
              ) : null}
            </div>
          </div>
          {isCompactViewport && chatPanelCollapsed ? (
            <p className="online-subtle">
              {isHost ? 'Chat collapsed to prioritize host controls.' : 'Chat collapsed for stream focus.'}
            </p>
          ) : (
            <>
              {session?.chat.length ? (
                <ul ref={chatListRef} className="chat-list" onScroll={onChatListScroll}>
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
              <div className="wizard-actions online-chat-presets">
                {QUICK_CHAT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => onSendQuickChat(preset)}
                    disabled={!canSendRealtimeInput}
                  >
                    {preset}
                  </button>
                ))}
              </div>
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
                    ref={chatInputRef}
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
              <p className="online-subtle">
                Tip: press <code>/</code> to focus chat, <code>Esc</code> to blur.
              </p>
            </>
          )}
        </section>
      ) : null}

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            saveMode={wizardMode}
            initialProfile={wizardMode === 'edit' ? activeProfile : wizardTemplateProfile}
            onCancel={() => {
              setWizardOpen(false);
              setWizardMode('create');
              setWizardTemplateProfile(undefined);
            }}
            onComplete={onProfileComplete}
          />
        </div>
      ) : null}

      {settingsModalOpen ? (
        <InSessionSettingsModal title="Online Session Settings" onClose={() => setSettingsModalOpen(false)} />
      ) : null}

      {!isHost && showVirtualController ? (
        <div className="virtual-controller-dock online-session-virtual-controller-dock">
          <div className="virtual-controller-dock-toolbar">
            <span>Virtual Controller</span>
            <div className="wizard-actions">
              <button
                type="button"
                onClick={() => setVirtualControllerMode((value) => (value === 'full' ? 'compact' : 'full'))}
              >
                {virtualControllerMode === 'full' ? 'Compact Pad Layout' : 'Expand Pad Layout'}
              </button>
              <button type="button" onClick={() => setVirtualControllerCollapsed((value) => !value)}>
                {virtualControllerCollapsed ? 'Show Controller' : 'Hide Controller'}
              </button>
            </div>
          </div>
          {!virtualControllerCollapsed ? (
            <VirtualController
              disabled={!canSendGuestControllerInput}
              mode={virtualControllerMode}
              onControlChange={onVirtualControlChange}
              onAnalogChange={onVirtualAnalogChange}
            />
          ) : (
            <p className="online-subtle">Controller is hidden. Expand when you need touch input.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
