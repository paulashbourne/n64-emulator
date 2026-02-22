import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, MutableRefObject } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ControllerWizard } from '../components/ControllerWizard';
import { InSessionSettingsModal } from '../components/InSessionSettingsModal';
import { VirtualController } from '../components/VirtualController';
import { UX_ONBOARDING_V2_ENABLED, UX_PLAY_NAV_V2_ENABLED, UX_PREF_SYNC_V1_ENABLED } from '../config/uxFlags';
import {
  deleteSlotSaveEverywhere,
  persistRuntimeSaveForSlot,
  reconcileSlotSaveWithCloud,
} from '../emulator/cloudSaveSync';
import { applyProfileToRunningEmulator, controllerProfileToEmulatorJsControls } from '../emulator/emulatorJsControls';
import {
  buildEmulatorGameId,
  chooseBootSaveSlot,
  clearSaveSlotProgress,
  createSaveSlot,
  deleteSaveSlot,
  listSaveSlotsForGame,
  markSaveSlotPlayed,
  markSaveSlotSaved,
  renameSaveSlot,
  resolveSaveGameIdentity,
  touchSaveSlot,
} from '../emulator/saveSlots';
import {
  clearEmulatorJsIndexedCaches,
  startEmulatorJs,
  stopEmulatorJs,
  type EmulatorBootMode,
} from '../emulator/emulatorJsRuntime';
import {
  PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES,
  createPreconfiguredGamepadProfileTemplate,
} from '../input/controllerProfilePresets';
import { N64_ANALOG_MAX_VALUE, N64_TARGET_TO_INPUT_INDEX } from '../emulator/n64InputMap';
import { resolveEmulatorSimulateInput } from '../emulator/simulateInput';
import { multiplayerSocketUrl } from '../online/multiplayerApi';
import {
  applyRemoteInputResetToHost,
  applyRemoteInputPayloadToHost,
  describeRemoteInputPayload,
  parseRemoteInputPayload,
} from '../online/remoteInputBridge';
import { buildInviteJoinUrl, buildSessionLibraryUrl, buildSessionRoute } from '../online/sessionLinks';
import { WEBRTC_CONFIGURATION } from '../online/webrtcConfig';
import { getRomArrayBuffer, getRomById } from '../roms/catalogService';
import { normalizeRomByteOrder } from '../roms/scanner';
import {
  getAdvancedSaveSlotsEnabled,
  getPreferredBootMode,
  setPreferredBootMode,
} from '../storage/appSettings';
import { useAppStore } from '../state/appStore';
import { useAuthStore } from '../state/authStore';
import { useOnboardingStore } from '../state/onboardingStore';
import { usePreferencesStore } from '../state/preferencesStore';
import type { ControllerProfile, N64ControlTarget } from '../types/input';
import type {
  HostStreamQualityPresetHint,
  MultiplayerInputPayload,
  MultiplayerSessionSnapshot,
  MultiplayerSocketMessage,
  MultiplayerWebRtcSignalPayload,
} from '../types/multiplayer';
import type { RomRecord } from '../types/rom';
import type { SaveGameIdentity, SaveSlotRecord } from '../types/save';

const PLAYER_SELECTOR = '#emulatorjs-player';
const ONLINE_HEARTBEAT_INTERVAL_MS = 10_000;
const ONLINE_STREAM_CAPTURE_FPS = 60;
const ONLINE_STREAM_POLL_INTERVAL_MS = 280;
const ONLINE_HOST_STREAM_STATS_INTERVAL_MS = 2_000;
const ONLINE_STREAM_AUTOTUNE_STREAK_REQUIRED = 3;
const ONLINE_STREAM_AUTOTUNE_COOLDOWN_MS = 12_000;
const ONLINE_VIEWER_AUTO_HEAL_POOR_STREAK_REQUIRED = 3;
const ONLINE_VIEWER_AUTO_HEAL_COOLDOWN_MS = 10_000;
const ONLINE_VIEWER_PRESSURE_AUTOSTABILIZE_COOLDOWN_MS = 14_000;
const ONLINE_VIEWER_PRESSURE_AUTOSTABILIZE_REPEAT_MS = 42_000;
const PLAY_VIEW_PREFERENCES_KEY = 'play_view_preferences_v1';
const ONLINE_HOST_DIAGNOSTICS_PREFERENCES_KEY = 'online_host_diagnostics_prefs_v2';
const ONLINE_HOST_ADVANCED_TOOLS_PREFERENCES_KEY = 'play_online_host_advanced_tools_v2';
const PLAY_MENU_TAB_PREFERENCES_KEY = 'play_menu_active_tab_v1';
const PLAY_HUD_AUTO_HIDE_DELAY_MS = 3_200;
const SAVE_AUTOSYNC_INTERVAL_MS = 20_000;
const PLAY_COMPACT_HUD_MAX_WIDTH = 980;
const ONLINE_AUDIO_DEFAULT_GAME_VOLUME = 0.5;
const ONLINE_AUDIO_DEFAULT_CHAT_VOLUME = 1;
const ONLINE_STREAM_MIN_VIDEO_BITRATE_BPS = 450_000;
const ONLINE_STREAM_LATENCY_GUARD_WARN_MS = 140;
const ONLINE_STREAM_LATENCY_GUARD_POOR_MS = 200;
const ONLINE_INPUT_DATA_CHANNEL_LABEL = 'warpdeck64-input-v1';
const ONLINE_VOICE_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

type SessionStatus = 'loading' | 'running' | 'paused' | 'error';
type WizardMode = 'create' | 'edit';
type PlayMenuTab = 'gameplay' | 'saves' | 'controls' | 'online';
type HostStreamQualityPreset = 'adaptive' | 'ultra_low_latency' | 'balanced' | 'quality';
type EffectiveHostStreamQualityPreset = Exclude<HostStreamQualityPreset, 'adaptive'>;
type HostWebRtcSignalMessage = Extract<MultiplayerSocketMessage, { type: 'webrtc_signal' }>;

interface HostStreamingPeerState {
  connection: RTCPeerConnection;
  negotiationInFlight: boolean;
  negotiated: boolean;
  disconnectTimer: number | null;
  inputChannel: RTCDataChannel | null;
}

interface HostStreamTelemetry {
  bitrateKbps?: number;
  fps?: number;
  rttMs?: number;
  qualityLimitationReason?: string;
}

interface HostViewerStreamTelemetry {
  bitrateKbps?: number;
  fps?: number;
  rttMs?: number;
  qualityLimitationReason?: string;
  sampledAtMs?: number;
}

interface HostQualityHintEvent {
  fromName: string;
  fromSlot: number;
  requestedPreset: HostStreamQualityPresetHint;
  reason?: string;
  at: number;
}

interface HostStreamHealthAssessment {
  label: string;
  className: string;
  detail: string;
  recommendedPreset?: EffectiveHostStreamQualityPreset;
}

interface HostViewerPressureAssessment {
  label: string;
  className: string;
  detail: string;
  degradedViewerClientIds: string[];
  poorViewerClientIds: string[];
  connectedViewerCount: number;
  degradedViewerCount: number;
}

interface HostStreamQualityProfile {
  label: string;
  description: string;
  maxBitrateBps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

interface PlayViewPreferences {
  autoHideHudWhileRunning: boolean;
}

interface OnlineHostDiagnosticsPreferences {
  autoApplyRecommendedPreset: boolean;
  autoHealViewerLinks: boolean;
  autoStabilizeViewerPressure: boolean;
}

const DEFAULT_PLAY_VIEW_PREFERENCES: PlayViewPreferences = {
  autoHideHudWhileRunning: true,
};

const DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES: OnlineHostDiagnosticsPreferences = {
  autoApplyRecommendedPreset: false,
  autoHealViewerLinks: false,
  autoStabilizeViewerPressure: false,
};

const HOST_STREAM_QUALITY_PROFILES: Record<EffectiveHostStreamQualityPreset, HostStreamQualityProfile> = {
  ultra_low_latency: {
    label: 'Ultra Low Latency',
    description: 'Prioritizes responsiveness with tighter bitrate and stronger downscaling for fast recovery.',
    maxBitrateBps: 1_200_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1.65,
  },
  balanced: {
    label: 'Balanced',
    description: 'Latency-first default that keeps motion smooth while preserving usable image detail.',
    maxBitrateBps: 2_300_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1.2,
  },
  quality: {
    label: 'Quality',
    description: 'Uses higher bitrate for cleaner frames when link health is consistently strong.',
    maxBitrateBps: 4_600_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1,
  },
};

function loadPlayViewPreferences(): PlayViewPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_PLAY_VIEW_PREFERENCES;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PLAY_VIEW_PREFERENCES_KEY);
  } catch {
    return DEFAULT_PLAY_VIEW_PREFERENCES;
  }
  if (!raw) {
    return DEFAULT_PLAY_VIEW_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PlayViewPreferences>;
    return {
      autoHideHudWhileRunning:
        typeof parsed.autoHideHudWhileRunning === 'boolean'
          ? parsed.autoHideHudWhileRunning
          : DEFAULT_PLAY_VIEW_PREFERENCES.autoHideHudWhileRunning,
    };
  } catch {
    return DEFAULT_PLAY_VIEW_PREFERENCES;
  }
}

function savePlayViewPreferences(preferences: PlayViewPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(PLAY_VIEW_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore persistence failures (private mode, quota, etc.) without affecting gameplay.
  }
}

function loadPlayMenuTabPreference(): PlayMenuTab {
  if (typeof window === 'undefined') {
    return 'gameplay';
  }
  try {
    const raw = window.localStorage.getItem(PLAY_MENU_TAB_PREFERENCES_KEY);
    if (raw === 'saves' || raw === 'controls' || raw === 'online' || raw === 'gameplay') {
      return raw;
    }
  } catch {
    // Ignore read failures and use default tab.
  }
  return 'gameplay';
}

function savePlayMenuTabPreference(tab: PlayMenuTab): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(PLAY_MENU_TAB_PREFERENCES_KEY, tab);
  } catch {
    // Ignore storage failures.
  }
}

function loadOnlineHostDiagnosticsPreferences(): OnlineHostDiagnosticsPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ONLINE_HOST_DIAGNOSTICS_PREFERENCES_KEY);
  } catch {
    return DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES;
  }
  if (!raw) {
    return DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OnlineHostDiagnosticsPreferences>;
    return {
      autoApplyRecommendedPreset:
        typeof parsed.autoApplyRecommendedPreset === 'boolean'
          ? parsed.autoApplyRecommendedPreset
          : DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES.autoApplyRecommendedPreset,
      autoHealViewerLinks:
        typeof parsed.autoHealViewerLinks === 'boolean'
          ? parsed.autoHealViewerLinks
          : DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES.autoHealViewerLinks,
      autoStabilizeViewerPressure:
        typeof parsed.autoStabilizeViewerPressure === 'boolean'
          ? parsed.autoStabilizeViewerPressure
          : DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES.autoStabilizeViewerPressure,
    };
  } catch {
    return DEFAULT_ONLINE_HOST_DIAGNOSTICS_PREFERENCES;
  }
}

function saveOnlineHostDiagnosticsPreferences(preferences: OnlineHostDiagnosticsPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(ONLINE_HOST_DIAGNOSTICS_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore persistence failures without impacting runtime controls.
  }
}

function saveOnlineHostAdvancedToolsPreference(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(ONLINE_HOST_ADVANCED_TOOLS_PREFERENCES_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore persistence failures without impacting runtime controls.
  }
}

function readPlayViewportState(): {
  coarsePointer: boolean;
  compactHud: boolean;
} {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return {
      coarsePointer: false,
      compactHud: false,
    };
  }

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  const viewportWidth = window.innerWidth;
  const compactHud = viewportWidth <= PLAY_COMPACT_HUD_MAX_WIDTH;
  return {
    coarsePointer,
    compactHud,
  };
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

function tryParsePeerInputPayload(raw: string): MultiplayerInputPayload | null {
  try {
    return parseRemoteInputPayload(JSON.parse(raw));
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

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function volumePercentLabel(value: number): string {
  return `${Math.round(clampVolume(value) * 100)}%`;
}

function normalizeOnlineSessionSnapshot(session: MultiplayerSessionSnapshot): MultiplayerSessionSnapshot {
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

function streamMetricClass(value: number | undefined, goodThreshold: number, warnThreshold: number): string {
  if (value === undefined) {
    return 'status-pill';
  }
  if (value <= goodThreshold) {
    return 'status-pill status-good';
  }
  if (value <= warnThreshold) {
    return 'status-pill status-warn';
  }
  return 'status-pill status-bad';
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

function formatElapsedFromNow(timestampMs: number | undefined): string {
  if (!timestampMs) {
    return 'Never';
  }

  const deltaMs = Math.max(0, Date.now() - timestampMs);
  if (deltaMs < 15_000) {
    return 'just now';
  }
  if (deltaMs < 60_000) {
    return `${Math.round(deltaMs / 1_000)}s ago`;
  }
  if (deltaMs < 3_600_000) {
    return `${Math.round(deltaMs / 60_000)}m ago`;
  }
  return `${Math.round(deltaMs / 3_600_000)}h ago`;
}

function viewerStreamHealth(
  telemetry: HostViewerStreamTelemetry | undefined,
  connected: boolean,
): { label: string; className: string } {
  if (!connected) {
    return {
      label: 'Disconnected',
      className: 'status-pill',
    };
  }

  if (!telemetry) {
    return {
      label: 'Negotiating',
      className: 'status-pill status-warn',
    };
  }

  const rtt = telemetry.rttMs;
  const fps = telemetry.fps;
  const qualityLimitationReason = telemetry.qualityLimitationReason;
  if (
    (qualityLimitationReason && qualityLimitationReason !== 'none') ||
    (rtt !== undefined && rtt >= 190) ||
    (fps !== undefined && fps < 40)
  ) {
    return {
      label: 'Poor',
      className: 'status-pill status-bad',
    };
  }

  if ((rtt !== undefined && rtt >= 130) || (fps !== undefined && fps < 52)) {
    return {
      label: 'Watch',
      className: 'status-pill status-warn',
    };
  }

  return {
    label: 'Healthy',
    className: 'status-pill status-good',
  };
}

function outboundVideoStats(report: RTCStats): RTCOutboundRtpStreamStats | undefined {
  if (report.type !== 'outbound-rtp') {
    return undefined;
  }
  const outbound = report as RTCOutboundRtpStreamStats & { mediaType?: string };
  const kind = outbound.kind ?? outbound.mediaType;
  return kind === 'video' ? outbound : undefined;
}

function assessHostStreamHealth(input: {
  telemetry: HostStreamTelemetry;
  relayLatencyMs: number | undefined;
  streamPeers: number;
  activePreset: EffectiveHostStreamQualityPreset;
}): HostStreamHealthAssessment {
  const { telemetry, relayLatencyMs, streamPeers, activePreset } = input;
  if (streamPeers <= 0) {
    return {
      label: 'Idle',
      className: 'status-pill',
      detail: 'No connected stream viewers yet. Launch and invite players to begin diagnostics.',
    };
  }

  const rtt = telemetry.rttMs ?? relayLatencyMs ?? 0;
  const fps = telemetry.fps ?? 60;
  const limitation = telemetry.qualityLimitationReason ?? 'none';
  const constrained = limitation !== 'none';

  if (constrained || rtt >= 185 || fps < 42) {
    return {
      label: 'Degraded',
      className: 'status-pill status-bad',
      detail: 'Stream quality is constrained. Use Ultra Low Latency to stabilize control responsiveness.',
      recommendedPreset: activePreset === 'ultra_low_latency' ? undefined : 'ultra_low_latency',
    };
  }

  if (rtt >= 130 || fps < 52) {
    return {
      label: 'Stressed',
      className: 'status-pill status-warn',
      detail: 'Latency or frame pacing is elevated. Balanced mode is recommended until conditions improve.',
      recommendedPreset: activePreset === 'balanced' ? undefined : 'balanced',
    };
  }

  if (rtt <= 85 && fps >= 57) {
    return {
      label: 'Healthy',
      className: 'status-pill status-good',
      detail: 'Network looks clean. Quality mode should hold visual clarity without hurting responsiveness.',
      recommendedPreset: activePreset === 'quality' ? undefined : 'quality',
    };
  }

  return {
    label: 'Stable',
    className: 'status-pill status-good',
    detail: 'Current stream path is stable. Keep monitoring if more players join.',
  };
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

function runtimeSaveBytes(): Uint8Array | null {
  const gameManager = window.EJS_emulator?.gameManager;
  if (!gameManager?.getSaveFile) {
    return null;
  }
  try {
    const result = gameManager.getSaveFile(true);
    return toUint8Array(result);
  } catch {
    return null;
  }
}

function writeRuntimeSaveBytes(bytes: Uint8Array): boolean {
  const gameManager = window.EJS_emulator?.gameManager;
  const savePath = gameManager?.getSaveFilePath?.();
  if (!gameManager?.writeFile || !gameManager?.loadSaveFiles || !savePath) {
    return false;
  }

  try {
    gameManager.writeFile(savePath, bytes);
    gameManager.loadSaveFiles();
    gameManager.saveSaveFiles?.();
    return true;
  } catch {
    return false;
  }
}

function clearRuntimeSaveBytes(): boolean {
  const gameManager = window.EJS_emulator?.gameManager;
  const savePath = gameManager?.getSaveFilePath?.();
  if (!savePath) {
    return false;
  }

  try {
    const exists = gameManager?.FS?.analyzePath?.(savePath)?.exists;
    if (exists) {
      gameManager?.FS?.unlink?.(savePath);
    } else if (gameManager?.writeFile) {
      gameManager.writeFile(savePath, new Uint8Array());
    }
    gameManager?.loadSaveFiles?.();
    gameManager?.saveSaveFiles?.();
    return true;
  } catch {
    return false;
  }
}

function saveFileNameSegment(value: string | undefined): string {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) {
    return 'save';
  }
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'save';
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
  const isAuthenticated = useAuthStore((state) => state.status === 'authenticated');
  const markOnboardingStepComplete = useOnboardingStore((state) => state.markStepComplete);
  const preferencesInitialized = usePreferencesStore((state) => state.initialized);
  const syncedPlayPreferences = usePreferencesStore((state) => state.preferences.play);
  const updatePlayPreferences = usePreferencesStore((state) => state.updatePlayPreferences);

  const decodedRomId = romId ? decodeURIComponent(romId) : undefined;
  const requestedSaveSlotId = (searchParams.get('saveSlot') ?? '').trim();
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
  const onlineRoute = sessionRoute ?? '/online';
  const initialHostDiagnosticsPreferences = useMemo(
    () => loadOnlineHostDiagnosticsPreferences(),
    [],
  );
  const initialViewportState = useMemo(() => readPlayViewportState(), []);

  const romBlobUrlRef = useRef<string | null>(null);
  const lastAppliedProfileRef = useRef<string | null>(null);
  const playStageRef = useRef<HTMLElement | null>(null);
  const saveFileInputRef = useRef<HTMLInputElement | null>(null);
  const quickProfileSwitchRef = useRef<HTMLDetailsElement | null>(null);
  const saveAutosyncTimerRef = useRef<number | null>(null);
  const onlineSocketRef = useRef<WebSocket | null>(null);
  const onlineReconnectTimerRef = useRef<number | null>(null);
  const onlineHeartbeatTimerRef = useRef<number | null>(null);
  const onlinePendingPingSentAtRef = useRef<number | null>(null);
  const onlineSessionClosedRef = useRef(false);
  const hudAutoHideTimerRef = useRef<number | null>(null);
  const wizardAutoPausedRef = useRef(false);
  const onlineHostStreamRef = useRef<MediaStream | null>(null);
  const onlineHostMicLocalStreamRef = useRef<MediaStream | null>(null);
  const onlineHostMicLocalTrackRef = useRef<MediaStreamTrack | null>(null);
  const onlineHostMicRelayStreamRef = useRef<MediaStream | null>(null);
  const onlineHostPeersRef = useRef<Map<string, HostStreamingPeerState>>(new Map());
  const onlineHostRelayVoiceTracksRef = useRef<Map<string, MediaStreamTrack>>(new Map());
  const onlineHostRelayVoiceStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const onlineHostVoicePlaybackRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const onlineHostStatsBaselineRef = useRef<Map<string, { bytesSent: number; measuredAtMs: number }>>(new Map());
  const onlineHostViewerTelemetryRef = useRef<Record<string, HostViewerStreamTelemetry>>({});
  const handleHostWebRtcSignalRef = useRef<((message: HostWebRtcSignalMessage) => void) | null>(null);
  const syncHostStreamingPeersRef = useRef<((session: MultiplayerSessionSnapshot) => void) | null>(null);
  const resyncHostStreamForClientRef = useRef<
    ((targetClientId: string, options?: { requestedBy?: string; reason?: string; silent?: boolean }) => void) | null
  >(null);
  const setEmulatorWarningRef = useRef(setEmulatorWarning);
  const onlineViewerAutoHealStateRef = useRef<
    Map<string, { poorStreak: number; lastAutoHealAt: number; lastSampleAt?: number }>
  >(new Map());
  const onlineViewerPressureAutoStabilizeRef = useRef<{
    lastAppliedAt: number;
    lastTargetKey: string;
  }>({
    lastAppliedAt: 0,
    lastTargetKey: '',
  });
  const onlineRomDescriptorRef = useRef<{ romId?: string; romTitle?: string }>({
    romId: decodedRomId,
    romTitle: undefined,
  });
  const onlineRecommendedPresetRef = useRef<{
    preset?: EffectiveHostStreamQualityPreset;
    streak: number;
    lastAppliedAt: number;
  }>({
    streak: 0,
    lastAppliedAt: 0,
  });
  const onlineHostGameVolumeBeforeMuteRef = useRef(ONLINE_AUDIO_DEFAULT_GAME_VOLUME);
  const onlineHostChatVolumeBeforeMuteRef = useRef(ONLINE_AUDIO_DEFAULT_CHAT_VOLUME);
  const appliedSyncedPlayPrefsRef = useRef(false);

  const [rom, setRom] = useState<RomRecord>();
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [backendLabel, setBackendLabel] = useState('EmulatorJS');
  const [coreLabel, setCoreLabel] = useState('parallel_n64');
  const [error, setError] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>('create');
  const [wizardTemplateProfile, setWizardTemplateProfile] = useState<ControllerProfile>();
  const [createProfileTemplateId, setCreateProfileTemplateId] = useState<string>('');
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeMenuTab, setActiveMenuTab] = useState<PlayMenuTab>(() => loadPlayMenuTabPreference());
  const [hudHiddenByUser, setHudHiddenByUser] = useState(false);
  const [hudAutoHidden, setHudAutoHidden] = useState(false);
  const [autoHideHudWhileRunning, setAutoHideHudWhileRunning] = useState(
    () => loadPlayViewPreferences().autoHideHudWhileRunning,
  );
  const [showVirtualController, setShowVirtualController] = useState(() =>
    initialViewportState.coarsePointer,
  );
  const [virtualControllerMode, setVirtualControllerMode] = useState<'full' | 'compact'>(() =>
    'compact',
  );
  const [isCompactHudViewport, setIsCompactHudViewport] = useState(() => initialViewportState.compactHud);
  const [compactActionTrayOpen, setCompactActionTrayOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [bootModeLoaded, setBootModeLoaded] = useState(false);
  const [bootNonce, setBootNonce] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [showAdvancedRecoveryOptions, setShowAdvancedRecoveryOptions] = useState(false);
  const [advancedSaveSlotsEnabled, setAdvancedSaveSlotsMode] = useState(false);
  const [saveGameIdentity, setSaveGameIdentity] = useState<SaveGameIdentity>();
  const [saveSlots, setSaveSlots] = useState<SaveSlotRecord[]>([]);
  const [activeSaveSlotId, setActiveSaveSlotId] = useState<string>();
  const [saveActivityMessage, setSaveActivityMessage] = useState<string>();
  const [savingState, setSavingState] = useState(false);
  const [onlineRelayStatus, setOnlineRelayStatus] = useState<'offline' | 'connecting' | 'connected'>(
    onlineRelayEnabled ? 'connecting' : 'offline',
  );
  const [onlineRemoteEventsApplied, setOnlineRemoteEventsApplied] = useState(0);
  const [onlineRemoteEventsBlocked, setOnlineRemoteEventsBlocked] = useState(0);
  const [onlineLastRemoteInput, setOnlineLastRemoteInput] = useState<string>();
  const [onlineConnectedMembers, setOnlineConnectedMembers] = useState(1);
  const [onlineLatencyMs, setOnlineLatencyMs] = useState<number>();
  const [onlineSessionSnapshot, setOnlineSessionSnapshot] = useState<MultiplayerSessionSnapshot>();
  const [onlineStreamPeers, setOnlineStreamPeers] = useState(0);
  const [onlineStreamQualityPreset, setOnlineStreamQualityPreset] =
    useState<HostStreamQualityPreset>('adaptive');
  const [onlineAutoApplyRecommendedPreset, setOnlineAutoApplyRecommendedPreset] = useState(
    () => initialHostDiagnosticsPreferences.autoApplyRecommendedPreset,
  );
  const [onlineAutoHealViewerLinks, setOnlineAutoHealViewerLinks] = useState(
    () => initialHostDiagnosticsPreferences.autoHealViewerLinks,
  );
  const [onlineAutoStabilizeViewerPressure, setOnlineAutoStabilizeViewerPressure] = useState(
    () => initialHostDiagnosticsPreferences.autoStabilizeViewerPressure,
  );
  const [showOnlineHostAdvancedTools, setShowOnlineHostAdvancedTools] = useState(false);
  const [onlineHostStreamTelemetry, setOnlineHostStreamTelemetry] = useState<HostStreamTelemetry>({});
  const [onlineHostGameVolume, setOnlineHostGameVolume] = useState(ONLINE_AUDIO_DEFAULT_GAME_VOLUME);
  const [onlineHostChatVolume, setOnlineHostChatVolume] = useState(ONLINE_AUDIO_DEFAULT_CHAT_VOLUME);
  const [onlineHostVoiceInputMuted, setOnlineHostVoiceInputMuted] = useState(true);
  const [onlineHostVoiceMicRequesting, setOnlineHostVoiceMicRequesting] = useState(false);
  const [onlineHostVoiceMicError, setOnlineHostVoiceMicError] = useState<string>();
  const [onlineHostStreamHasGameAudio, setOnlineHostStreamHasGameAudio] = useState(false);
  const [onlineHostViewerTelemetry, setOnlineHostViewerTelemetry] = useState<
    Record<string, HostViewerStreamTelemetry>
  >({});
  const [onlineViewerLastResyncAt, setOnlineViewerLastResyncAt] = useState<Record<string, number>>({});
  const [onlineResyncingViewerClientId, setOnlineResyncingViewerClientId] = useState<string>();
  const [onlineLastQualityHint, setOnlineLastQualityHint] = useState<HostQualityHintEvent>();
  const hudVisible = wizardOpen || (!menuOpen && !hudHiddenByUser && !hudAutoHidden);
  const isGameInteractive = status === 'running' || status === 'paused';
  const virtualControllerBlocked = status === 'loading' || status === 'error' || menuOpen || wizardOpen;
  const virtualControllerOverlayBlocked = menuOpen || wizardOpen;
  const shouldRenderVirtualController = showVirtualController && isGameInteractive;
  const inlineSecondaryActionsVisible = !isCompactHudViewport || compactActionTrayOpen;
  const hasCompactHiddenActions = isCompactHudViewport && isGameInteractive;
  const playSessionLabel = onlineRelayEnabled ? `Online ${onlineCode}` : 'Local Play';
  const statusLabel =
    status === 'loading' ? 'Loading' : status === 'running' ? 'Running' : status === 'paused' ? 'Paused' : 'Error';
  const isCatalogMissingError = (error ?? '').toLowerCase().includes('not found in the catalog');
  const statusClass =
    status === 'running'
      ? 'status-pill status-good'
      : status === 'paused'
        ? 'status-pill status-warn'
        : status === 'error'
          ? 'status-pill status-bad'
          : 'status-pill';
  const saveSyncStatus: {
    local: 'ready' | 'working' | 'issue';
    cloud: 'ready' | 'working' | 'issue' | 'local-only';
  } = useMemo(() => {
    const message = (saveActivityMessage ?? '').toLowerCase();
    const hasErrorSignal =
      message.includes('failed')
      || message.includes('unavailable')
      || message.includes('could not');
    const cloudStatus = !isAuthenticated
      ? 'local-only'
      : savingState
        ? 'working'
        : hasErrorSignal
          ? 'issue'
          : 'ready';
    return {
      local: savingState ? 'working' : hasErrorSignal ? 'issue' : 'ready',
      cloud: cloudStatus,
    };
  }, [isAuthenticated, saveActivityMessage, savingState]);

  useEffect(() => {
    if (!UX_PLAY_NAV_V2_ENABLED) {
      return;
    }
    savePlayMenuTabPreference(activeMenuTab);
  }, [activeMenuTab]);

  useEffect(() => {
    if (!UX_PREF_SYNC_V1_ENABLED || !preferencesInitialized || appliedSyncedPlayPrefsRef.current) {
      return;
    }
    appliedSyncedPlayPrefsRef.current = true;

    if (typeof syncedPlayPreferences.autoHideHudWhileRunning === 'boolean') {
      setAutoHideHudWhileRunning(syncedPlayPreferences.autoHideHudWhileRunning);
    }
    if (UX_PLAY_NAV_V2_ENABLED && syncedPlayPreferences.activeMenuTab) {
      setActiveMenuTab(syncedPlayPreferences.activeMenuTab);
    }
    if (typeof syncedPlayPreferences.showOnlineAdvancedTools === 'boolean') {
      setShowOnlineHostAdvancedTools(syncedPlayPreferences.showOnlineAdvancedTools);
    }
  }, [preferencesInitialized, syncedPlayPreferences]);

  useEffect(() => {
    if (!onlineRelayEnabled && activeMenuTab === 'online') {
      setActiveMenuTab('gameplay');
    }
  }, [activeMenuTab, onlineRelayEnabled]);

  useEffect(() => {
    if (status === 'running') {
      if (UX_ONBOARDING_V2_ENABLED) {
        markOnboardingStepComplete('launch_game');
      }
    }
  }, [markOnboardingStepComplete, status]);

  useEffect(() => {
    if (activeProfileId) {
      if (UX_ONBOARDING_V2_ENABLED) {
        markOnboardingStepComplete('verify_controls');
      }
    }
  }, [activeProfileId, markOnboardingStepComplete]);

  useEffect(() => {
    if (!UX_PREF_SYNC_V1_ENABLED || !preferencesInitialized) {
      return;
    }
    void updatePlayPreferences({
      autoHideHudWhileRunning,
      activeMenuTab,
      showOnlineAdvancedTools: showOnlineHostAdvancedTools,
    }).catch(() => {
      // Preference sync is best-effort.
    });
  }, [
    activeMenuTab,
    autoHideHudWhileRunning,
    preferencesInitialized,
    showOnlineHostAdvancedTools,
    updatePlayPreferences,
  ]);

  useEffect(() => {
    onlineHostViewerTelemetryRef.current = onlineHostViewerTelemetry;
  }, [onlineHostViewerTelemetry]);

  const activeProfile = useMemo<ControllerProfile | undefined>(
    () => profiles.find((profile) => profile.profileId === activeProfileId),
    [profiles, activeProfileId],
  );
  const activeSaveSlot = useMemo<SaveSlotRecord | undefined>(
    () => saveSlots.find((slot) => slot.slotId === activeSaveSlotId),
    [activeSaveSlotId, saveSlots],
  );
  const isOnlineHost = onlineRelayEnabled && onlineSessionSnapshot?.hostClientId === onlineClientId;
  const onlineVoiceEnabled = Boolean(onlineSessionSnapshot?.voiceEnabled);
  const onlineGuestMembers = useMemo(
    () =>
      (onlineSessionSnapshot?.members ?? []).filter(
        (member) => !member.isHost && member.clientId !== onlineClientId,
      ),
    [onlineClientId, onlineSessionSnapshot?.members],
  );
  const onlineMutedInputClientIds = useMemo(
    () => onlineSessionSnapshot?.mutedInputClientIds ?? [],
    [onlineSessionSnapshot?.mutedInputClientIds],
  );
  const onlineHostViewerRows = useMemo(
    () =>
      onlineGuestMembers.map((member) => {
        const telemetry = onlineHostViewerTelemetry[member.clientId];
        const lastResyncAt = onlineViewerLastResyncAt[member.clientId];
        return {
          member,
          telemetry,
          health: viewerStreamHealth(telemetry, member.connected),
          lastResyncAt,
        };
      }),
    [onlineGuestMembers, onlineHostViewerTelemetry, onlineViewerLastResyncAt],
  );
  const isOnlineHostRef = useRef(false);
  const onlineSessionSnapshotRef = useRef<MultiplayerSessionSnapshot | undefined>(undefined);
  const effectiveOnlineStreamQualityPreset = useMemo<EffectiveHostStreamQualityPreset>(() => {
    if (onlineStreamQualityPreset !== 'adaptive') {
      return onlineStreamQualityPreset;
    }

    const streamRtt = onlineHostStreamTelemetry.rttMs;
    const relayRtt = onlineLatencyMs;
    const limitation = onlineHostStreamTelemetry.qualityLimitationReason;
    if (
      limitation === 'bandwidth' ||
      limitation === 'cpu' ||
      (streamRtt !== undefined && streamRtt >= 180) ||
      (relayRtt !== undefined && relayRtt >= 210)
    ) {
      return 'ultra_low_latency';
    }

    if ((streamRtt !== undefined && streamRtt >= 110) || (relayRtt !== undefined && relayRtt >= 130)) {
      return 'balanced';
    }

    if (
      onlineStreamPeers <= 1 &&
      (streamRtt === undefined || streamRtt <= 55) &&
      (relayRtt === undefined || relayRtt <= 65) &&
      (!limitation || limitation === 'none')
    ) {
      return 'quality';
    }

    return 'balanced';
  }, [
    onlineHostStreamTelemetry.qualityLimitationReason,
    onlineHostStreamTelemetry.rttMs,
    onlineLatencyMs,
    onlineStreamPeers,
    onlineStreamQualityPreset,
  ]);
  const hostStreamHealthAssessment = useMemo(
    () =>
      assessHostStreamHealth({
        telemetry: onlineHostStreamTelemetry,
        relayLatencyMs: onlineLatencyMs,
        streamPeers: onlineStreamPeers,
        activePreset: effectiveOnlineStreamQualityPreset,
      }),
    [effectiveOnlineStreamQualityPreset, onlineHostStreamTelemetry, onlineLatencyMs, onlineStreamPeers],
  );
  const recommendedStreamPreset = hostStreamHealthAssessment.recommendedPreset;
  const hostViewerPressureAssessment = useMemo<HostViewerPressureAssessment>(() => {
    const connectedRows = onlineHostViewerRows.filter((row) => row.member.connected);
    const poorRows = connectedRows.filter((row) => row.health.label === 'Poor');
    const watchRows = connectedRows.filter((row) => row.health.label === 'Watch');
    const degradedRows = [...poorRows, ...watchRows];

    if (connectedRows.length === 0) {
      return {
        label: 'Idle',
        className: 'status-pill',
        detail: 'No connected viewers yet.',
        degradedViewerClientIds: [],
        poorViewerClientIds: [],
        connectedViewerCount: 0,
        degradedViewerCount: 0,
      };
    }

    const poorCount = poorRows.length;
    const watchCount = watchRows.length;
    const degradedCount = degradedRows.length;
    const degradedViewerClientIds = degradedRows.map((row) => row.member.clientId);
    const poorViewerClientIds = poorRows.map((row) => row.member.clientId);

    if (poorCount >= 2 || (poorCount >= 1 && watchCount >= 1)) {
      return {
        label: 'High',
        className: 'status-pill status-bad',
        detail:
          'Multiple viewers are degrading. Apply Ultra Low Latency and re-sync degraded viewers to stabilize the room.',
        degradedViewerClientIds,
        poorViewerClientIds,
        connectedViewerCount: connectedRows.length,
        degradedViewerCount: degradedCount,
      };
    }

    if (poorCount >= 1 || watchCount >= 2) {
      return {
        label: 'Elevated',
        className: 'status-pill status-warn',
        detail: 'Some viewers are under pressure. Re-sync degraded links before conditions worsen.',
        degradedViewerClientIds,
        poorViewerClientIds,
        connectedViewerCount: connectedRows.length,
        degradedViewerCount: degradedCount,
      };
    }

    if (watchCount >= 1) {
      return {
        label: 'Watch',
        className: 'status-pill status-warn',
        detail: 'One viewer is trending upward in latency. Monitor closely or proactively re-sync.',
        degradedViewerClientIds,
        poorViewerClientIds,
        connectedViewerCount: connectedRows.length,
        degradedViewerCount: degradedCount,
      };
    }

    return {
      label: 'Clear',
      className: 'status-pill status-good',
      detail: 'All connected viewer links look healthy.',
      degradedViewerClientIds,
      poorViewerClientIds,
      connectedViewerCount: connectedRows.length,
      degradedViewerCount: degradedCount,
    };
  }, [onlineHostViewerRows]);

  const clearHudAutoHideTimer = useCallback((): void => {
    if (hudAutoHideTimerRef.current !== null) {
      window.clearTimeout(hudAutoHideTimerRef.current);
      hudAutoHideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost || !onlineAutoApplyRecommendedPreset) {
      onlineRecommendedPresetRef.current.preset = undefined;
      onlineRecommendedPresetRef.current.streak = 0;
      return;
    }

    if (onlineStreamQualityPreset === 'adaptive') {
      onlineRecommendedPresetRef.current.preset = undefined;
      onlineRecommendedPresetRef.current.streak = 0;
      return;
    }

    const recommendation = recommendedStreamPreset;
    if (!recommendation || recommendation === effectiveOnlineStreamQualityPreset) {
      onlineRecommendedPresetRef.current.preset = undefined;
      onlineRecommendedPresetRef.current.streak = 0;
      return;
    }

    if (onlineRecommendedPresetRef.current.preset === recommendation) {
      onlineRecommendedPresetRef.current.streak += 1;
    } else {
      onlineRecommendedPresetRef.current.preset = recommendation;
      onlineRecommendedPresetRef.current.streak = 1;
    }

    if (onlineRecommendedPresetRef.current.streak < ONLINE_STREAM_AUTOTUNE_STREAK_REQUIRED) {
      return;
    }

    const now = Date.now();
    if (now - onlineRecommendedPresetRef.current.lastAppliedAt < ONLINE_STREAM_AUTOTUNE_COOLDOWN_MS) {
      return;
    }

    onlineRecommendedPresetRef.current.lastAppliedAt = now;
    onlineRecommendedPresetRef.current.streak = 0;
    onlineRecommendedPresetRef.current.preset = undefined;
    setOnlineStreamQualityPreset(recommendation);
    setEmulatorWarning(`Auto-adjusted stream mode to ${HOST_STREAM_QUALITY_PROFILES[recommendation].label}.`);
  }, [
    effectiveOnlineStreamQualityPreset,
    isOnlineHost,
    onlineAutoApplyRecommendedPreset,
    onlineRelayEnabled,
    onlineStreamQualityPreset,
    recommendedStreamPreset,
    setEmulatorWarning,
  ]);

  useEffect(() => {
    savePlayViewPreferences({
      autoHideHudWhileRunning,
    });
  }, [autoHideHudWhileRunning]);

  useEffect(() => {
    saveOnlineHostDiagnosticsPreferences({
      autoApplyRecommendedPreset: onlineAutoApplyRecommendedPreset,
      autoHealViewerLinks: onlineAutoHealViewerLinks,
      autoStabilizeViewerPressure: onlineAutoStabilizeViewerPressure,
    });
  }, [
    onlineAutoApplyRecommendedPreset,
    onlineAutoHealViewerLinks,
    onlineAutoStabilizeViewerPressure,
  ]);

  useEffect(() => {
    saveOnlineHostAdvancedToolsPreference(showOnlineHostAdvancedTools);
  }, [showOnlineHostAdvancedTools]);

  useEffect(() => {
    isOnlineHostRef.current = isOnlineHost;
  }, [isOnlineHost]);

  useEffect(() => {
    onlineSessionSnapshotRef.current = onlineSessionSnapshot;
  }, [onlineSessionSnapshot]);

  useEffect(() => {
    setEmulatorWarningRef.current = setEmulatorWarning;
  }, [setEmulatorWarning]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const compactHudQuery = window.matchMedia(`(max-width: ${PLAY_COMPACT_HUD_MAX_WIDTH}px)`);
    const onChange = (): void => {
      setIsCompactHudViewport(compactHudQuery.matches);
    };
    onChange();

    if (typeof compactHudQuery.addEventListener === 'function') {
      compactHudQuery.addEventListener('change', onChange);
      return () => {
        compactHudQuery.removeEventListener('change', onChange);
      };
    }

    compactHudQuery.addListener(onChange);
    return () => {
      compactHudQuery.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    if (!isCompactHudViewport) {
      setCompactActionTrayOpen(false);
    }
  }, [isCompactHudViewport]);

  useEffect(() => {
    if (isCompactHudViewport && virtualControllerMode !== 'compact') {
      setVirtualControllerMode('compact');
    }
  }, [isCompactHudViewport, virtualControllerMode]);

  useEffect(() => {
    if (menuOpen || wizardOpen || status === 'loading' || status === 'error') {
      setCompactActionTrayOpen(false);
    }
  }, [menuOpen, status, wizardOpen]);

  useEffect(() => {
    if (status !== 'error') {
      setShowAdvancedRecoveryOptions(false);
      return;
    }

    if (isCatalogMissingError) {
      setShowAdvancedRecoveryOptions(false);
    }
  }, [isCatalogMissingError, status]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    if (menuOpen || wizardOpen) {
      document.body.classList.add('play-no-scroll');
    } else {
      document.body.classList.remove('play-no-scroll');
    }

    return () => {
      document.body.classList.remove('play-no-scroll');
    };
  }, [menuOpen, wizardOpen]);

  const setOnlineStreamPeerCountFromMap = useCallback((): void => {
    setOnlineStreamPeers(onlineHostPeersRef.current.size);
  }, []);

  const stopOnlineHostVoicePlaybackForClient = useCallback((clientId: string): void => {
    const element = onlineHostVoicePlaybackRef.current.get(clientId);
    if (!element) {
      return;
    }
    element.pause();
    element.srcObject = null;
    onlineHostVoicePlaybackRef.current.delete(clientId);
  }, []);

  const clearOnlineHostVoicePlayback = useCallback((): void => {
    for (const clientId of Array.from(onlineHostVoicePlaybackRef.current.keys())) {
      stopOnlineHostVoicePlaybackForClient(clientId);
    }
  }, [stopOnlineHostVoicePlaybackForClient]);

  const applyOnlineHostChatPlaybackVolume = useCallback((volume: number): void => {
    const normalized = clampVolume(volume);
    for (const element of onlineHostVoicePlaybackRef.current.values()) {
      element.volume = normalized;
    }
  }, []);

  const getOnlineHostRelayVoiceStream = useCallback((clientId: string, track: MediaStreamTrack): MediaStream => {
    const existing = onlineHostRelayVoiceStreamsRef.current.get(clientId);
    if (existing) {
      const existingTrack = existing.getAudioTracks()[0];
      if (!existingTrack || existingTrack.id !== track.id) {
        for (const candidate of existing.getTracks()) {
          existing.removeTrack(candidate);
        }
        existing.addTrack(track);
      }
      return existing;
    }

    const created = new MediaStream([track]);
    onlineHostRelayVoiceStreamsRef.current.set(clientId, created);
    return created;
  }, []);

  const getOnlineHostMicRelayStream = useCallback((track: MediaStreamTrack): MediaStream => {
    const existing = onlineHostMicRelayStreamRef.current;
    if (existing) {
      const existingTrack = existing.getAudioTracks()[0];
      if (!existingTrack || existingTrack.id !== track.id) {
        for (const candidate of existing.getTracks()) {
          existing.removeTrack(candidate);
        }
        existing.addTrack(track);
      }
      return existing;
    }

    const created = new MediaStream([track]);
    onlineHostMicRelayStreamRef.current = created;
    return created;
  }, []);

  const removeOnlineHostRelayVoiceTrack = useCallback((clientId: string): boolean => {
    let removed = false;
    if (onlineHostRelayVoiceTracksRef.current.delete(clientId)) {
      removed = true;
    }
    if (onlineHostRelayVoiceStreamsRef.current.delete(clientId)) {
      removed = true;
    }
    stopOnlineHostVoicePlaybackForClient(clientId);
    return removed;
  }, [stopOnlineHostVoicePlaybackForClient]);

  const stopOnlineHostVoiceCapture = useCallback((): boolean => {
    const stream = onlineHostMicLocalStreamRef.current;
    const track = onlineHostMicLocalTrackRef.current;
    const hadCapture = Boolean(stream || track);

    if (stream) {
      stream.getTracks().forEach((candidate) => candidate.stop());
    } else if (track) {
      track.stop();
    }

    onlineHostMicLocalStreamRef.current = null;
    onlineHostMicLocalTrackRef.current = null;
    onlineHostMicRelayStreamRef.current = null;
    setOnlineHostVoiceMicRequesting(false);
    return hadCapture;
  }, []);

  const ensureOnlineHostVoiceCapture = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const currentTrack = onlineHostMicLocalTrackRef.current;
    if (currentTrack && currentTrack.readyState === 'live') {
      return currentTrack;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setOnlineHostVoiceMicError('Microphone capture is unavailable in this browser.');
      return null;
    }

    setOnlineHostVoiceMicRequesting(true);
    setOnlineHostVoiceMicError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(ONLINE_VOICE_MEDIA_CONSTRAINTS);
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((candidate) => candidate.stop());
        throw new Error('No microphone track was detected.');
      }
      const previousStream = onlineHostMicLocalStreamRef.current;
      if (previousStream && previousStream !== stream) {
        previousStream.getTracks().forEach((candidate) => candidate.stop());
      }
      onlineHostMicLocalStreamRef.current = stream;
      onlineHostMicLocalTrackRef.current = track;
      return track;
    } catch (captureError) {
      const message =
        captureError instanceof Error && captureError.message.trim().length > 0
          ? captureError.message
          : 'Microphone permission was denied.';
      setOnlineHostVoiceMicError(message);
      return null;
    } finally {
      setOnlineHostVoiceMicRequesting(false);
    }
  }, []);

  const closeOnlineHostPeer = useCallback((clientId: string): void => {
    const peerState = onlineHostPeersRef.current.get(clientId);
    if (!peerState) {
      removeOnlineHostRelayVoiceTrack(clientId);
      return;
    }

    if (peerState.disconnectTimer !== null) {
      window.clearTimeout(peerState.disconnectTimer);
      peerState.disconnectTimer = null;
    }

    if (peerState.inputChannel) {
      peerState.inputChannel.onopen = null;
      peerState.inputChannel.onclose = null;
      peerState.inputChannel.onerror = null;
      peerState.inputChannel.onmessage = null;
      try {
        peerState.inputChannel.close();
      } catch {
        // Ignore channel close failures while tearing down peers.
      }
      peerState.inputChannel = null;
    }

    peerState.connection.onicecandidate = null;
    peerState.connection.onconnectionstatechange = null;
    peerState.connection.ondatachannel = null;
    peerState.connection.ontrack = null;
    peerState.connection.close();
    onlineHostPeersRef.current.delete(clientId);
    onlineHostStatsBaselineRef.current.delete(clientId);
    removeOnlineHostRelayVoiceTrack(clientId);
    setOnlineHostViewerTelemetry((current) => {
      if (!(clientId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[clientId];
      return next;
    });
    setOnlineStreamPeerCountFromMap();
  }, [removeOnlineHostRelayVoiceTrack, setOnlineStreamPeerCountFromMap]);

  const clearOnlineHostPeers = useCallback((): void => {
    for (const clientId of Array.from(onlineHostPeersRef.current.keys())) {
      closeOnlineHostPeer(clientId);
    }
    onlineHostStatsBaselineRef.current.clear();
    onlineHostRelayVoiceTracksRef.current.clear();
    onlineHostRelayVoiceStreamsRef.current.clear();
    clearOnlineHostVoicePlayback();
    setOnlineHostStreamTelemetry({});
    setOnlineHostViewerTelemetry({});
    setOnlineStreamPeerCountFromMap();
  }, [clearOnlineHostVoicePlayback, closeOnlineHostPeer, setOnlineStreamPeerCountFromMap]);

  const stopOnlineHostStream = useCallback((): void => {
    const stream = onlineHostStreamRef.current;
    if (!stream) {
      setOnlineHostStreamHasGameAudio(false);
      return;
    }

    stream.getTracks().forEach((track) => track.stop());
    onlineHostStreamRef.current = null;
    setOnlineHostStreamHasGameAudio(false);
  }, []);

  const applyHostStreamQualityToConnection = useCallback((
    connection: RTCPeerConnection,
    targetClientId?: string,
  ): void => {
    const profile = HOST_STREAM_QUALITY_PROFILES[effectiveOnlineStreamQualityPreset];
    const viewerTelemetry = targetClientId
      ? onlineHostViewerTelemetryRef.current[targetClientId]
      : undefined;
    const relayPingMs = targetClientId
      ? onlineSessionSnapshotRef.current?.members.find((member) => member.clientId === targetClientId)?.pingMs
      : undefined;
    const measuredLatencyMs = Math.max(viewerTelemetry?.rttMs ?? 0, relayPingMs ?? 0);

    let bitrateMultiplier = 1;
    let scaleResolutionBoost = 0;
    let maxFramerate = profile.maxFramerate;
    if (measuredLatencyMs >= ONLINE_STREAM_LATENCY_GUARD_POOR_MS) {
      bitrateMultiplier = 0.58;
      scaleResolutionBoost = 0.9;
      maxFramerate = Math.min(profile.maxFramerate, 52);
    } else if (measuredLatencyMs >= ONLINE_STREAM_LATENCY_GUARD_WARN_MS) {
      bitrateMultiplier = 0.78;
      scaleResolutionBoost = 0.4;
      maxFramerate = Math.min(profile.maxFramerate, 56);
    }
    const targetBitrate = Math.max(
      ONLINE_STREAM_MIN_VIDEO_BITRATE_BPS,
      Math.round(profile.maxBitrateBps * bitrateMultiplier),
    );
    const targetScaleResolutionDownBy = Math.max(
      1,
      Number((profile.scaleResolutionDownBy + scaleResolutionBoost).toFixed(2)),
    );

    for (const sender of connection.getSenders()) {
      if (sender.track?.kind !== 'video') {
        continue;
      }

      try {
        if (sender.track.contentHint !== 'motion') {
          sender.track.contentHint = 'motion';
        }
      } catch {
        // Ignore track hint failures on browsers that restrict runtime hint changes.
      }

      const parameters = sender.getParameters();
      const existingEncoding = parameters.encodings?.[0] ?? {};
      const nextEncoding: RTCRtpEncodingParameters = {
        ...existingEncoding,
        maxBitrate: targetBitrate,
        maxFramerate,
        scaleResolutionDownBy: targetScaleResolutionDownBy,
        priority: 'high',
        networkPriority: 'high',
      };
      const nextParameters = {
        ...parameters,
        encodings: [nextEncoding],
      } as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference };
      nextParameters.degradationPreference = 'maintain-framerate';
      void sender.setParameters(nextParameters).catch(() => {
        // Tuning can fail on some browsers/versions; keep streaming with defaults.
      });
    }
  }, [effectiveOnlineStreamQualityPreset]);

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

  const handleIncomingGuestInput = useCallback((input: {
    fromClientId: string;
    payload: MultiplayerInputPayload | null;
    fromName?: string;
    fromSlot?: number;
  }): void => {
    if (!isOnlineHostRef.current) {
      return;
    }

    const session = onlineSessionSnapshotRef.current;
    const member = session?.members.find((candidate) => candidate.clientId === input.fromClientId);
    const fromName = member?.name ?? input.fromName;
    const fromSlot = member?.slot ?? input.fromSlot;
    if (!fromName || typeof fromSlot !== 'number' || !Number.isInteger(fromSlot)) {
      return;
    }

    const inputDescription = describeRemoteInputPayload(input.payload);
    const mutedByHost = member ? (session?.mutedInputClientIds ?? []).includes(member.clientId) : false;
    if (mutedByHost) {
      const resetApplied = applyRemoteInputResetToHost(fromSlot);
      if (resetApplied) {
        setOnlineRemoteEventsBlocked((current) => current + 1);
        setOnlineLastRemoteInput(`${fromName} (${fromSlot}) ${inputDescription} input muted by host.`);
      }
      return;
    }

    const applied = applyRemoteInputPayloadToHost({
      fromSlot,
      payload: input.payload,
    });
    if (!applied) {
      setOnlineLastRemoteInput(`${fromName} (${fromSlot}) ${inputDescription} not applied.`);
      return;
    }

    setOnlineRemoteEventsApplied((current) => current + 1);
    setOnlineLastRemoteInput(`${fromName} (${fromSlot}) ${inputDescription}`);
  }, []);

  const attachHostInputDataChannel = useCallback((targetClientId: string, channel: RTCDataChannel): void => {
    const peerState = onlineHostPeersRef.current.get(targetClientId);
    if (!peerState) {
      try {
        channel.close();
      } catch {
        // Ignore close failures for channels created during shutdown races.
      }
      return;
    }

    const previous = peerState.inputChannel;
    if (previous && previous !== channel) {
      previous.onopen = null;
      previous.onclose = null;
      previous.onerror = null;
      previous.onmessage = null;
      try {
        previous.close();
      } catch {
        // Ignore close failures while replacing channels.
      }
    }

    peerState.inputChannel = channel;
    const clearIfCurrent = (): void => {
      const latest = onlineHostPeersRef.current.get(targetClientId);
      if (!latest || latest.inputChannel !== channel) {
        return;
      }
      latest.inputChannel = null;
    };

    channel.onopen = () => {
      const latest = onlineHostPeersRef.current.get(targetClientId);
      if (!latest || latest.inputChannel !== channel) {
        return;
      }
      latest.inputChannel = channel;
    };
    channel.onclose = clearIfCurrent;
    channel.onerror = clearIfCurrent;
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      const parsedPayload = tryParsePeerInputPayload(event.data);
      handleIncomingGuestInput({
        fromClientId: targetClientId,
        payload: parsedPayload,
      });
    };
  }, [handleIncomingGuestInput]);

  const ensureHostInputDataChannel = useCallback((targetClientId: string): boolean => {
    const peerState = onlineHostPeersRef.current.get(targetClientId);
    if (!peerState || peerState.inputChannel) {
      return false;
    }

    const channel = peerState.connection.createDataChannel(ONLINE_INPUT_DATA_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    attachHostInputDataChannel(targetClientId, channel);
    return true;
  }, [attachHostInputDataChannel]);

  const ensureHostPeerNegotiation = useCallback((targetClientId: string): void => {
    const peerState = onlineHostPeersRef.current.get(targetClientId);
    if (!peerState || peerState.negotiationInFlight) {
      return;
    }
    if (peerState.connection.signalingState !== 'stable') {
      return;
    }

    peerState.negotiationInFlight = true;
    void (async () => {
      try {
        const offer = await peerState.connection.createOffer();
        await peerState.connection.setLocalDescription(offer);
        peerState.negotiated = false;
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

    connection.ontrack = (event) => {
      if (event.track.kind !== 'audio') {
        return;
      }

      const incomingTrack = event.track;
      if (incomingTrack.readyState !== 'live') {
        return;
      }

      onlineHostRelayVoiceTracksRef.current.set(targetClientId, incomingTrack);
      const playbackStream = new MediaStream([incomingTrack]);
      let playbackElement = onlineHostVoicePlaybackRef.current.get(targetClientId);
      if (!playbackElement) {
        playbackElement = document.createElement('audio');
        playbackElement.autoplay = true;
        onlineHostVoicePlaybackRef.current.set(targetClientId, playbackElement);
      }
      playbackElement.srcObject = playbackStream;
      playbackElement.volume = clampVolume(onlineHostChatVolume);
      void playbackElement.play().catch(() => {
        // Autoplay can be blocked until user interaction on some browsers.
      });

      incomingTrack.onended = () => {
        const currentTrack = onlineHostRelayVoiceTracksRef.current.get(targetClientId);
        if (!currentTrack || currentTrack.id !== incomingTrack.id) {
          return;
        }
        const removed = removeOnlineHostRelayVoiceTrack(targetClientId);
        if (removed && onlineSessionSnapshotRef.current) {
          syncHostStreamingPeersRef.current?.(onlineSessionSnapshotRef.current);
        }
      };

      if (onlineSessionSnapshotRef.current) {
        syncHostStreamingPeersRef.current?.(onlineSessionSnapshotRef.current);
      }
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        closeOnlineHostPeer(targetClientId);
        return;
      }

      const peerState = onlineHostPeersRef.current.get(targetClientId);
      if (!peerState) {
        return;
      }

      if (connection.connectionState === 'disconnected') {
        if (peerState.disconnectTimer !== null) {
          return;
        }
        peerState.disconnectTimer = window.setTimeout(() => {
          peerState.disconnectTimer = null;
          if (connection.connectionState === 'disconnected') {
            closeOnlineHostPeer(targetClientId);
          }
        }, 3_500);
        return;
      }

      if (peerState.disconnectTimer !== null) {
        window.clearTimeout(peerState.disconnectTimer);
        peerState.disconnectTimer = null;
      }
    };

    connection.ondatachannel = (event) => {
      if (event.channel.label !== ONLINE_INPUT_DATA_CHANNEL_LABEL) {
        return;
      }
      attachHostInputDataChannel(targetClientId, event.channel);
    };

    return connection;
  }, [
    attachHostInputDataChannel,
    closeOnlineHostPeer,
    onlineHostChatVolume,
    removeOnlineHostRelayVoiceTrack,
    sendWebRtcSignal,
  ]);

  const attachHostStreamToPeer = useCallback((
    connection: RTCPeerConnection,
    targetClientId: string,
  ): { hasMediaTrack: boolean; trackAdded: boolean; trackRemoved: boolean } => {
    const desiredTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();

    const hostStream = onlineHostStreamRef.current;
    if (hostStream) {
      for (const track of hostStream.getTracks()) {
        if (track.readyState !== 'live') {
          continue;
        }
        desiredTracks.set(track.id, {
          track,
          stream: hostStream,
        });
      }
    }

    if (onlineVoiceEnabled) {
      const hostMicTrack = onlineHostMicLocalTrackRef.current;
      if (hostMicTrack && hostMicTrack.readyState === 'live') {
        desiredTracks.set(hostMicTrack.id, {
          track: hostMicTrack,
          stream: getOnlineHostMicRelayStream(hostMicTrack),
        });
      }
    }

    for (const [clientId, voiceTrack] of Array.from(onlineHostRelayVoiceTracksRef.current.entries())) {
      if (clientId === targetClientId) {
        continue;
      }
      if (voiceTrack.readyState !== 'live') {
        removeOnlineHostRelayVoiceTrack(clientId);
        continue;
      }
      desiredTracks.set(voiceTrack.id, {
        track: voiceTrack,
        stream: getOnlineHostRelayVoiceStream(clientId, voiceTrack),
      });
    }

    let trackRemoved = false;
    for (const sender of connection.getSenders()) {
      const senderTrack = sender.track;
      if (!senderTrack) {
        continue;
      }
      if (!desiredTracks.has(senderTrack.id)) {
        connection.removeTrack(sender);
        trackRemoved = true;
      }
    }

    const existingTrackIds = new Set(
      connection
        .getSenders()
        .map((sender) => sender.track?.id)
        .filter((trackId): trackId is string => typeof trackId === 'string'),
    );

    let trackAdded = false;
    for (const { track, stream } of desiredTracks.values()) {
      if (!existingTrackIds.has(track.id)) {
        connection.addTrack(track, stream);
        existingTrackIds.add(track.id);
        trackAdded = true;
      }
    }

    applyHostStreamQualityToConnection(connection, targetClientId);

    return {
      hasMediaTrack: desiredTracks.size > 0,
      trackAdded,
      trackRemoved,
    };
  }, [
    applyHostStreamQualityToConnection,
    getOnlineHostMicRelayStream,
    getOnlineHostRelayVoiceStream,
    onlineVoiceEnabled,
    removeOnlineHostRelayVoiceTrack,
  ]);

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
          negotiated: false,
          disconnectTimer: null,
          inputChannel: null,
        };
        onlineHostPeersRef.current.set(member.clientId, peerState);
      }

      const channelAdded = ensureHostInputDataChannel(member.clientId);
      const attachment = attachHostStreamToPeer(peerState.connection, member.clientId);
      const shouldNegotiate = channelAdded || attachment.trackAdded || attachment.trackRemoved || !peerState.negotiated;
      if (attachment.hasMediaTrack && shouldNegotiate) {
        ensureHostPeerNegotiation(member.clientId);
      }
    }

    setOnlineStreamPeerCountFromMap();
  }, [
    attachHostStreamToPeer,
    clearOnlineHostPeers,
    closeOnlineHostPeer,
    createHostPeerConnection,
    ensureHostInputDataChannel,
    ensureHostPeerNegotiation,
    onlineClientId,
    setOnlineStreamPeerCountFromMap,
  ]);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    for (const [clientId, peerState] of onlineHostPeersRef.current.entries()) {
      applyHostStreamQualityToConnection(peerState.connection, clientId);
    }
  }, [
    applyHostStreamQualityToConnection,
    isOnlineHost,
    onlineHostViewerTelemetry,
    onlineRelayEnabled,
    onlineSessionSnapshot?.members,
    onlineStreamPeers,
  ]);

  const handleHostWebRtcSignal = useCallback((message: HostWebRtcSignalMessage): void => {
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
        negotiated: false,
        disconnectTimer: null,
        inputChannel: null,
      };
      onlineHostPeersRef.current.set(senderClientId, peerState);
      ensureHostInputDataChannel(senderClientId);
      attachHostStreamToPeer(peerState.connection, senderClientId);
      setOnlineStreamPeerCountFromMap();
    }

    if (message.payload.kind === 'answer') {
      void peerState.connection
        .setRemoteDescription({
          type: 'answer',
          sdp: message.payload.sdp,
        })
        .then(() => {
          const latest = onlineHostPeersRef.current.get(senderClientId);
          if (latest) {
            latest.negotiated = true;
          }
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
    ensureHostInputDataChannel,
    setOnlineStreamPeerCountFromMap,
  ]);

  const resyncHostStreamForClient = useCallback(
    (
      targetClientId: string,
      options?: {
        requestedBy?: string;
        reason?: string;
        silent?: boolean;
      },
    ): void => {
      closeOnlineHostPeer(targetClientId);
      const session = onlineSessionSnapshotRef.current;
      if (session) {
        syncHostStreamingPeers(session);
      }

      const now = Date.now();
      setOnlineViewerLastResyncAt((current) => ({
        ...current,
        [targetClientId]: now,
      }));

      if (options?.silent) {
        return;
      }
      if (options?.requestedBy) {
        setEmulatorWarning(`Stream resync requested by ${options.requestedBy}.`);
        return;
      }
      if (options?.reason) {
        setEmulatorWarning(options.reason);
      }
    },
    [closeOnlineHostPeer, setEmulatorWarning, syncHostStreamingPeers],
  );

  useEffect(() => {
    syncHostStreamingPeersRef.current = syncHostStreamingPeers;
  }, [syncHostStreamingPeers]);

  useEffect(() => {
    handleHostWebRtcSignalRef.current = handleHostWebRtcSignal;
  }, [handleHostWebRtcSignal]);

  useEffect(() => {
    resyncHostStreamForClientRef.current = resyncHostStreamForClient;
  }, [resyncHostStreamForClient]);

  const onResyncViewerStream = useCallback(
    (targetClientId: string, targetLabel: string): void => {
      setOnlineResyncingViewerClientId(targetClientId);
      resyncHostStreamForClient(targetClientId, {
        reason: `Requested fresh stream negotiation for ${targetLabel}.`,
      });
      window.setTimeout(() => {
        setOnlineResyncingViewerClientId((current) => (current === targetClientId ? undefined : current));
      }, 1_200);
    },
    [resyncHostStreamForClient],
  );

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost || !onlineAutoHealViewerLinks) {
      onlineViewerAutoHealStateRef.current.clear();
      return;
    }

    const now = Date.now();
    const trackedClientIds = new Set(onlineHostViewerRows.map((row) => row.member.clientId));
    for (const clientId of onlineViewerAutoHealStateRef.current.keys()) {
      if (!trackedClientIds.has(clientId)) {
        onlineViewerAutoHealStateRef.current.delete(clientId);
      }
    }

    let healedThisPass = false;
    for (const row of onlineHostViewerRows) {
      const clientId = row.member.clientId;
      if (!row.member.connected) {
        onlineViewerAutoHealStateRef.current.delete(clientId);
        continue;
      }

      const tracker = onlineViewerAutoHealStateRef.current.get(clientId) ?? {
        poorStreak: 0,
        lastAutoHealAt: 0,
        lastSampleAt: undefined,
      };

      const sampleMarker = row.telemetry?.sampledAtMs ?? now;
      if (tracker.lastSampleAt === sampleMarker) {
        onlineViewerAutoHealStateRef.current.set(clientId, tracker);
        continue;
      }
      tracker.lastSampleAt = sampleMarker;

      if (row.health.label === 'Poor') {
        tracker.poorStreak += 1;
      } else {
        tracker.poorStreak = 0;
      }

      const readyForAutoHeal =
        !healedThisPass &&
        tracker.poorStreak >= ONLINE_VIEWER_AUTO_HEAL_POOR_STREAK_REQUIRED &&
        now - tracker.lastAutoHealAt >= ONLINE_VIEWER_AUTO_HEAL_COOLDOWN_MS;
      if (readyForAutoHeal) {
        tracker.poorStreak = 0;
        tracker.lastAutoHealAt = now;
        healedThisPass = true;
        resyncHostStreamForClient(clientId, {
          reason: `Auto-healed ${row.member.name}'s stream link after sustained poor telemetry.`,
        });
      }

      onlineViewerAutoHealStateRef.current.set(clientId, tracker);
    }
  }, [isOnlineHost, onlineAutoHealViewerLinks, onlineHostViewerRows, onlineRelayEnabled, resyncHostStreamForClient]);

  const onResyncAllGuestStreams = useCallback((): void => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    const session = onlineSessionSnapshotRef.current;
    if (!session) {
      setEmulatorWarning('Waiting for room state before resyncing streams.');
      return;
    }

    clearOnlineHostPeers();
    syncHostStreamingPeers(session);
    const now = Date.now();
    setOnlineViewerLastResyncAt((current) => {
      const next = { ...current };
      for (const member of onlineGuestMembers) {
        next[member.clientId] = now;
      }
      return next;
    });
    setOnlineResyncingViewerClientId(undefined);
    setEmulatorWarning('Requested fresh stream negotiation for all connected guests.');
  }, [
    clearOnlineHostPeers,
    isOnlineHost,
    onlineGuestMembers,
    onlineRelayEnabled,
    setEmulatorWarning,
    syncHostStreamingPeers,
  ]);

  const stabilizeViewerLinks = useCallback(
    (targetClientIds: string[], source: 'manual' | 'auto'): boolean => {
      if (!onlineRelayEnabled || !isOnlineHost) {
        return false;
      }

      if (targetClientIds.length === 0) {
        if (source === 'manual') {
          setEmulatorWarning('No degraded viewer links to stabilize right now.');
        }
        return false;
      }

      if (effectiveOnlineStreamQualityPreset !== 'ultra_low_latency') {
        setOnlineStreamQualityPreset('ultra_low_latency');
      }

      for (const clientId of targetClientIds) {
        resyncHostStreamForClient(clientId, { silent: true });
      }
      setOnlineResyncingViewerClientId(undefined);
      setEmulatorWarning(
        source === 'manual'
          ? `Stabilizing ${targetClientIds.length} viewer link${
              targetClientIds.length === 1 ? '' : 's'
            } (Ultra Low Latency + re-sync).`
          : `Auto-stabilized ${targetClientIds.length} viewer link${
              targetClientIds.length === 1 ? '' : 's'
            } due to high viewer pressure.`,
      );
      return true;
    },
    [
      effectiveOnlineStreamQualityPreset,
      isOnlineHost,
      onlineRelayEnabled,
      resyncHostStreamForClient,
      setEmulatorWarning,
    ],
  );

  const onStabilizeDegradedViewers = useCallback((): void => {
    const targets =
      hostViewerPressureAssessment.poorViewerClientIds.length > 0
        ? hostViewerPressureAssessment.poorViewerClientIds
        : hostViewerPressureAssessment.degradedViewerClientIds;
    void stabilizeViewerLinks(targets, 'manual');
  }, [
    hostViewerPressureAssessment.degradedViewerClientIds,
    hostViewerPressureAssessment.poorViewerClientIds,
    stabilizeViewerLinks,
  ]);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost || !onlineAutoStabilizeViewerPressure) {
      onlineViewerPressureAutoStabilizeRef.current.lastAppliedAt = 0;
      onlineViewerPressureAutoStabilizeRef.current.lastTargetKey = '';
      return;
    }

    if (hostViewerPressureAssessment.label !== 'High') {
      return;
    }

    const targets =
      hostViewerPressureAssessment.poorViewerClientIds.length > 0
        ? hostViewerPressureAssessment.poorViewerClientIds
        : hostViewerPressureAssessment.degradedViewerClientIds;
    if (targets.length === 0) {
      return;
    }

    const sortedTargets = [...targets].sort();
    const targetKey = sortedTargets.join(',');
    const tracker = onlineViewerPressureAutoStabilizeRef.current;
    const now = Date.now();
    const cooldownMs =
      tracker.lastTargetKey === targetKey
        ? ONLINE_VIEWER_PRESSURE_AUTOSTABILIZE_REPEAT_MS
        : ONLINE_VIEWER_PRESSURE_AUTOSTABILIZE_COOLDOWN_MS;
    if (now - tracker.lastAppliedAt < cooldownMs) {
      return;
    }

    const stabilized = stabilizeViewerLinks(sortedTargets, 'auto');
    if (!stabilized) {
      return;
    }

    tracker.lastAppliedAt = now;
    tracker.lastTargetKey = targetKey;
  }, [
    hostViewerPressureAssessment.degradedViewerClientIds,
    hostViewerPressureAssessment.label,
    hostViewerPressureAssessment.poorViewerClientIds,
    isOnlineHost,
    onlineAutoStabilizeViewerPressure,
    onlineRelayEnabled,
    stabilizeViewerLinks,
  ]);

  const onApplyRequestedStreamMode = useCallback((): void => {
    if (!onlineLastQualityHint) {
      return;
    }
    setOnlineStreamQualityPreset(onlineLastQualityHint.requestedPreset);
    setEmulatorWarning(
      `Applied ${HOST_STREAM_QUALITY_PROFILES[onlineLastQualityHint.requestedPreset].label} from Player ${
        onlineLastQualityHint.fromSlot
      } request.`,
    );
  }, [onlineLastQualityHint, setEmulatorWarning]);

  const onHostGameVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const nextVolume = clampVolume(Number(event.target.value));
    setOnlineHostGameVolume(nextVolume);
  }, []);

  const onHostChatVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const nextVolume = clampVolume(Number(event.target.value));
    setOnlineHostChatVolume(nextVolume);
  }, []);

  const onToggleHostGameAudioMute = useCallback((): void => {
    if (onlineHostGameVolume > 0.001) {
      onlineHostGameVolumeBeforeMuteRef.current = onlineHostGameVolume;
      setOnlineHostGameVolume(0);
      return;
    }
    const restored = onlineHostGameVolumeBeforeMuteRef.current;
    setOnlineHostGameVolume(clampVolume(restored > 0.001 ? restored : ONLINE_AUDIO_DEFAULT_GAME_VOLUME));
  }, [onlineHostGameVolume]);

  const onToggleHostChatAudioMute = useCallback((): void => {
    if (onlineHostChatVolume > 0.001) {
      onlineHostChatVolumeBeforeMuteRef.current = onlineHostChatVolume;
      setOnlineHostChatVolume(0);
      return;
    }
    const restored = onlineHostChatVolumeBeforeMuteRef.current;
    setOnlineHostChatVolume(clampVolume(restored > 0.001 ? restored : ONLINE_AUDIO_DEFAULT_CHAT_VOLUME));
  }, [onlineHostChatVolume]);

  const onToggleHostVoiceInputMuted = useCallback((): void => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    if (!onlineVoiceEnabled) {
      setEmulatorWarning('Enable voice chat in the room first.');
      return;
    }

    if (!onlineHostVoiceInputMuted) {
      setOnlineHostVoiceInputMuted(true);
      const stoppedCapture = stopOnlineHostVoiceCapture();
      if (stoppedCapture && onlineSessionSnapshotRef.current) {
        syncHostStreamingPeers(onlineSessionSnapshotRef.current);
      }
      return;
    }

    void (async () => {
      const track = await ensureOnlineHostVoiceCapture();
      if (!track) {
        setOnlineHostVoiceInputMuted(true);
        return;
      }
      track.enabled = true;
      setOnlineHostVoiceInputMuted(false);
      if (onlineSessionSnapshotRef.current) {
        syncHostStreamingPeers(onlineSessionSnapshotRef.current);
      }
    })();
  }, [
    ensureOnlineHostVoiceCapture,
    isOnlineHost,
    onlineHostVoiceInputMuted,
    onlineRelayEnabled,
    onlineVoiceEnabled,
    setEmulatorWarning,
    stopOnlineHostVoiceCapture,
    syncHostStreamingPeers,
  ]);

  const onToggleGuestInputMute = useCallback((clientId: string): void => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    const socket = onlineSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'set_input_mute',
        targetClientId: clientId,
        muted: !onlineMutedInputClientIds.includes(clientId),
      }),
    );
  }, [isOnlineHost, onlineMutedInputClientIds, onlineRelayEnabled]);

  const onMuteAllGuestInputs = useCallback((): void => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    const socket = onlineSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const member of onlineGuestMembers) {
      socket.send(
        JSON.stringify({
          type: 'set_input_mute',
          targetClientId: member.clientId,
          muted: true,
        }),
      );
    }
  }, [isOnlineHost, onlineGuestMembers, onlineRelayEnabled]);

  const onUnmuteAllGuestInputs = useCallback((): void => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      return;
    }
    const socket = onlineSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const member of onlineGuestMembers) {
      socket.send(
        JSON.stringify({
          type: 'set_input_mute',
          targetClientId: member.clientId,
          muted: false,
        }),
      );
    }
  }, [isOnlineHost, onlineGuestMembers, onlineRelayEnabled]);

  const tryStartHostStreamCapture = useCallback((): boolean => {
    if (!isOnlineHostRef.current) {
      return false;
    }

    const existingStream = onlineHostStreamRef.current;
    if (existingStream?.getVideoTracks().some((track) => track.readyState === 'live')) {
      setOnlineHostStreamHasGameAudio(
        existingStream.getAudioTracks().some((track) => track.readyState === 'live'),
      );
      return true;
    }

    const playerCanvas = document.querySelector(`${PLAYER_SELECTOR} canvas`);
    if (!(playerCanvas instanceof HTMLCanvasElement) || typeof playerCanvas.captureStream !== 'function') {
      return false;
    }

    const emulator = window.EJS_emulator as
      | (typeof window.EJS_emulator & {
          collectScreenRecordingMediaTracks?: (canvas: HTMLCanvasElement, fps: number) => MediaStream | null;
        })
      | undefined;
    let capturedStream: MediaStream;
    try {
      capturedStream =
        emulator?.collectScreenRecordingMediaTracks?.(playerCanvas, ONLINE_STREAM_CAPTURE_FPS) ??
        playerCanvas.captureStream(ONLINE_STREAM_CAPTURE_FPS);
    } catch {
      capturedStream = playerCanvas.captureStream(ONLINE_STREAM_CAPTURE_FPS);
    }
    const videoTrack = capturedStream.getVideoTracks()[0];
    if (!videoTrack) {
      capturedStream.getTracks().forEach((track) => track.stop());
      return false;
    }
    try {
      if (videoTrack.contentHint !== 'motion') {
        videoTrack.contentHint = 'motion';
      }
    } catch {
      // Some browsers lock content hints for captured tracks; continue with defaults.
    }

    stopOnlineHostStream();
    onlineHostStreamRef.current = capturedStream;
    setOnlineHostStreamHasGameAudio(
      capturedStream.getAudioTracks().some((track) => track.readyState === 'live'),
    );
    if (onlineSessionSnapshotRef.current) {
      syncHostStreamingPeers(onlineSessionSnapshotRef.current);
    }
    return true;
  }, [stopOnlineHostStream, syncHostStreamingPeers]);

  useEffect(() => {
    setEmulatorWarning(undefined);
  }, [decodedRomId, setEmulatorWarning]);

  useEffect(() => {
    applyOnlineHostChatPlaybackVolume(onlineHostChatVolume);
  }, [applyOnlineHostChatPlaybackVolume, onlineHostChatVolume]);

  useEffect(() => {
    const normalizedVolume = clampVolume(onlineHostGameVolume);
    const hostWindow = window as Window & { EJS_volume?: number };
    hostWindow.EJS_volume = normalizedVolume;

    const emulator = window.EJS_emulator as
      | (typeof window.EJS_emulator & {
          setVolume?: (volume: number) => void;
          volume?: number;
        })
      | undefined;
    if (!emulator?.setVolume) {
      return;
    }

    emulator.volume = normalizedVolume;
    emulator.setVolume(normalizedVolume);
  }, [onlineHostGameVolume, status]);

  useEffect(() => {
    if (onlineRelayEnabled && isOnlineHost && onlineVoiceEnabled) {
      return;
    }

    const stoppedCapture = stopOnlineHostVoiceCapture();
    if (!onlineHostVoiceInputMuted) {
      setOnlineHostVoiceInputMuted(true);
    }
    setOnlineHostVoiceMicError(undefined);
    if (stoppedCapture && onlineSessionSnapshotRef.current) {
      syncHostStreamingPeers(onlineSessionSnapshotRef.current);
    }
  }, [
    isOnlineHost,
    onlineHostVoiceInputMuted,
    onlineRelayEnabled,
    onlineVoiceEnabled,
    stopOnlineHostVoiceCapture,
    syncHostStreamingPeers,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadBootMode = async (): Promise<void> => {
      const [preferredBootMode, advancedSaveSlots] = await Promise.all([
        getPreferredBootMode(),
        getAdvancedSaveSlotsEnabled(),
      ]);
      if (cancelled) {
        return;
      }
      setBootMode(preferredBootMode);
      setAdvancedSaveSlotsMode(advancedSaveSlots);
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
      setSaveActivityMessage(undefined);
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
        const identity = resolveSaveGameIdentity(selectedRom);
        const { activeSlot, slots } = await chooseBootSaveSlot(identity, {
          requestedSlotId: requestedSaveSlotId || undefined,
        });

        if (cancelled) {
          return;
        }

        setSaveGameIdentity(identity);
        setSaveSlots(slots);
        setActiveSaveSlotId(activeSlot.slotId);
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
          gameId: buildEmulatorGameId(identity.gameKey, activeSlot.slotId),
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
        await Promise.all([
          markLastPlayed(selectedRom.id),
          markSaveSlotPlayed(activeSlot.slotId),
        ]);
        let refreshedSlots = await listSaveSlotsForGame(identity.gameKey);
        setSaveSlots(refreshedSlots);
        setActiveSaveSlotId(activeSlot.slotId);
        let refreshedActive = refreshedSlots.find((slot) => slot.slotId === activeSlot.slotId);

        let restoredSyncedData = false;
        if (refreshedActive) {
          try {
            const reconciliation = await reconcileSlotSaveWithCloud({
              slot: refreshedActive,
              authenticated: isAuthenticated,
            });
            if (reconciliation.bytesToApply && reconciliation.bytesToApply.byteLength > 0) {
              const restored = writeRuntimeSaveBytes(reconciliation.bytesToApply);
              if (restored) {
                await markSaveSlotSaved(refreshedActive.slotId);
                refreshedSlots = await listSaveSlotsForGame(identity.gameKey);
                setSaveSlots(refreshedSlots);
                refreshedActive = refreshedSlots.find((slot) => slot.slotId === refreshedActive?.slotId);
                setSaveActivityMessage('Restored synced save data for this slot.');
                restoredSyncedData = true;
              }
            }
          } catch (syncError) {
            const message = syncError instanceof Error ? syncError.message : 'Cloud save sync unavailable.';
            console.warn(`Cloud save reconcile failed: ${message}`);
          }
        }

        if (refreshedActive && !restoredSyncedData) {
          setSaveActivityMessage(`Autosave slot: ${refreshedActive.slotName}`);
        }

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
      if (saveAutosyncTimerRef.current !== null) {
        window.clearInterval(saveAutosyncTimerRef.current);
        saveAutosyncTimerRef.current = null;
      }
      stopEmulatorJs(PLAYER_SELECTOR);
      revokeRomBlobUrl(romBlobUrlRef);
    };
  }, [bootMode, bootModeLoaded, bootNonce, decodedRomId, isAuthenticated, loadProfiles, markLastPlayed, requestedSaveSlotId]);

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
      stopOnlineHostVoiceCapture();
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
      socket.send(
        JSON.stringify({
          type: 'ping',
          sentAt: onlinePendingPingSentAtRef.current,
        }),
      );
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
        setOnlineLastQualityHint(undefined);
        setOnlineRemoteEventsBlocked(0);
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
          const normalizedSession = normalizeOnlineSessionSnapshot(message.session);
          const connectedMembers = normalizedSession.members.filter((member) => member.connected).length;
          setOnlineSessionSnapshot(normalizedSession);
          setOnlineConnectedMembers(Math.max(connectedMembers, 1));
          syncHostStreamingPeersRef.current?.(normalizedSession);
          return;
        }

        if (message.type === 'member_latency') {
          setOnlineSessionSnapshot((current) => {
            if (!current) {
              return current;
            }
            let changed = false;
            const nextMembers = current.members.map((member) => {
              if (member.clientId !== message.clientId) {
                return member;
              }
              if (member.pingMs === message.pingMs) {
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
          handleHostWebRtcSignalRef.current?.(message);
          return;
        }

        if (message.type === 'stream_resync_request') {
          if (isOnlineHostRef.current) {
            resyncHostStreamForClientRef.current?.(
              message.fromClientId,
              {
                requestedBy: `${message.fromName} (Player ${message.fromSlot})`,
              },
            );
          }
          return;
        }

        if (message.type === 'quality_hint') {
          if (isOnlineHostRef.current) {
            setOnlineLastQualityHint({
              fromName: message.fromName,
              fromSlot: message.fromSlot,
              requestedPreset: message.requestedPreset,
              reason: message.reason,
              at: message.at,
            });
            const presetLabel = HOST_STREAM_QUALITY_PROFILES[message.requestedPreset].label;
            const reasonText = message.reason ? ` ${message.reason}` : '';
            setEmulatorWarningRef.current?.(
              `Player ${message.fromSlot} (${message.fromName}) requested ${presetLabel}.${reasonText}`,
            );
          }
          return;
        }

        if (message.type === 'remote_input_reset') {
          if (!isOnlineHostRef.current) {
            return;
          }

          const resetApplied = applyRemoteInputResetToHost(message.fromSlot);
          if (resetApplied) {
            setOnlineLastRemoteInput(
              `${message.fromName} (${message.fromSlot}) input reset${message.reason ? `: ${message.reason}` : ''}.`,
            );
          }
          return;
        }

        if (message.type === 'session_closed') {
          onlineSessionClosedRef.current = true;
          clearReconnectTimer();
          clearHeartbeatTimer();
          setOnlineRelayStatus('offline');
          setOnlineSessionSnapshot(undefined);
          setOnlineLastQualityHint(undefined);
          setOnlineRemoteEventsBlocked(0);
          clearOnlineHostPeers();
          stopOnlineHostStream();
          setEmulatorWarningRef.current?.(message.reason || 'Online session closed.');
          socket.close();
          return;
        }

        if (message.type === 'input_blocked') {
          if (!isOnlineHostRef.current) {
            return;
          }
          const parsedPayload = parseRemoteInputPayload(message.payload);
          const inputDescription = describeRemoteInputPayload(parsedPayload);
          setOnlineRemoteEventsBlocked((current) => current + 1);
          setOnlineLastRemoteInput(`${message.fromName} (${message.fromSlot}) ${inputDescription} input muted by host.`);
          return;
        }

        if (message.type !== 'remote_input') {
          return;
        }

        handleIncomingGuestInput({
          fromClientId: message.fromClientId,
          fromName: message.fromName,
          fromSlot: message.fromSlot,
          payload: parseRemoteInputPayload(message.payload),
        });
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
      stopOnlineHostVoiceCapture();
      const socket = onlineSocketRef.current;
      if (socket) {
        socket.close();
        onlineSocketRef.current = null;
      }
    };
  }, [
    clearOnlineHostPeers,
    handleIncomingGuestInput,
    onlineClientId,
    onlineCode,
    onlineRelayEnabled,
    stopOnlineHostVoiceCapture,
    stopOnlineHostStream,
  ]);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost) {
      clearOnlineHostPeers();
      stopOnlineHostStream();
      stopOnlineHostVoiceCapture();
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
    stopOnlineHostVoiceCapture,
    stopOnlineHostStream,
    syncHostStreamingPeers,
    tryStartHostStreamCapture,
  ]);

  useEffect(() => {
    if (!onlineRelayEnabled || !isOnlineHost || onlineStreamPeers === 0) {
      onlineHostStatsBaselineRef.current.clear();
      setOnlineHostStreamTelemetry({});
      setOnlineHostViewerTelemetry({});
      return;
    }

    let cancelled = false;

    const pollHostStreamTelemetry = async (): Promise<void> => {
      const connectedPeers = Array.from(onlineHostPeersRef.current.entries());
      if (connectedPeers.length === 0) {
        if (!cancelled) {
          onlineHostStatsBaselineRef.current.clear();
          setOnlineHostStreamTelemetry({});
        }
        return;
      }

      let bitrateSum = 0;
      let bitrateSamples = 0;
      let fpsSum = 0;
      let fpsSamples = 0;
      let rttSum = 0;
      let rttSamples = 0;
      const qualityLimitCounts = new Map<string, number>();
      const nextViewerTelemetry: Record<string, HostViewerStreamTelemetry> = {};

      for (const [clientId, peerState] of connectedPeers) {
        const sampleMeasuredAt = Date.now();
        try {
          const stats = await peerState.connection.getStats();
          let outbound: RTCOutboundRtpStreamStats | undefined;
          let candidatePair: RTCIceCandidatePairStats | undefined;

          for (const report of stats.values()) {
            const outboundVideo = outboundVideoStats(report);
            if (outboundVideo) {
              outbound = outboundVideo;
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

          if (outbound) {
            const bytesSent = typeof outbound.bytesSent === 'number' ? outbound.bytesSent : undefined;
            const measuredAtMs = performance.now();
            let peerBitrateKbps: number | undefined;
            if (bytesSent !== undefined) {
              const previous = onlineHostStatsBaselineRef.current.get(clientId);
              if (previous && measuredAtMs > previous.measuredAtMs && bytesSent >= previous.bytesSent) {
                const deltaBytes = bytesSent - previous.bytesSent;
                const deltaSeconds = (measuredAtMs - previous.measuredAtMs) / 1_000;
                if (deltaSeconds > 0) {
                  const measuredBitrateKbps = (deltaBytes * 8) / 1_000 / deltaSeconds;
                  peerBitrateKbps = Math.round(measuredBitrateKbps);
                  bitrateSum += measuredBitrateKbps;
                  bitrateSamples += 1;
                }
              }
              onlineHostStatsBaselineRef.current.set(clientId, {
                bytesSent,
                measuredAtMs,
              });
            }

            if (typeof outbound.framesPerSecond === 'number') {
              fpsSum += outbound.framesPerSecond;
              fpsSamples += 1;
            }

            if (outbound.qualityLimitationReason && outbound.qualityLimitationReason !== 'none') {
              const reason = outbound.qualityLimitationReason;
              qualityLimitCounts.set(reason, (qualityLimitCounts.get(reason) ?? 0) + 1);
            }

            nextViewerTelemetry[clientId] = {
              ...nextViewerTelemetry[clientId],
              bitrateKbps: peerBitrateKbps,
              fps:
                typeof outbound.framesPerSecond === 'number'
                  ? Number(outbound.framesPerSecond.toFixed(1))
                  : nextViewerTelemetry[clientId]?.fps,
              qualityLimitationReason: outbound.qualityLimitationReason,
              sampledAtMs: sampleMeasuredAt,
            };
          }

          if (candidatePair?.currentRoundTripTime !== undefined) {
            rttSum += candidatePair.currentRoundTripTime * 1_000;
            rttSamples += 1;
            nextViewerTelemetry[clientId] = {
              ...nextViewerTelemetry[clientId],
              rttMs: Math.round(candidatePair.currentRoundTripTime * 1_000),
              sampledAtMs: sampleMeasuredAt,
            };
          }
        } catch {
          // Skip peer telemetry failures; one bad peer should not block diagnostics.
        }
      }

      if (cancelled) {
        return;
      }

      const dominantQualityLimit =
        qualityLimitCounts.size > 0
          ? [...qualityLimitCounts.entries()].sort((left, right) => right[1] - left[1])[0][0]
          : 'none';

      setOnlineHostStreamTelemetry({
        bitrateKbps: bitrateSamples > 0 ? Math.round(bitrateSum / bitrateSamples) : undefined,
        fps: fpsSamples > 0 ? Number((fpsSum / fpsSamples).toFixed(1)) : undefined,
        rttMs: rttSamples > 0 ? Math.round(rttSum / rttSamples) : undefined,
        qualityLimitationReason: dominantQualityLimit,
      });
      setOnlineHostViewerTelemetry(nextViewerTelemetry);
    };

    void pollHostStreamTelemetry();
    const timer = window.setInterval(() => {
      void pollHostStreamTelemetry();
    }, ONLINE_HOST_STREAM_STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isOnlineHost, onlineRelayEnabled, onlineStreamPeers]);

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

  useEffect(() => {
    if (
      !autoHideHudWhileRunning ||
      hudHiddenByUser ||
      menuOpen ||
      wizardOpen ||
      status !== 'running'
    ) {
      clearHudAutoHideTimer();
      setHudAutoHidden(false);
      return;
    }

    const stage = playStageRef.current;
    if (!stage) {
      return;
    }

    const armAutoHide = (): void => {
      clearHudAutoHideTimer();
      hudAutoHideTimerRef.current = window.setTimeout(() => {
        setHudAutoHidden(true);
      }, PLAY_HUD_AUTO_HIDE_DELAY_MS);
    };

    const onUserActivity = (): void => {
      setHudAutoHidden(false);
      armAutoHide();
    };

    armAutoHide();
    stage.addEventListener('pointermove', onUserActivity, { passive: true });
    stage.addEventListener('pointerdown', onUserActivity, { passive: true });
    stage.addEventListener('touchstart', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity);

    return () => {
      stage.removeEventListener('pointermove', onUserActivity);
      stage.removeEventListener('pointerdown', onUserActivity);
      stage.removeEventListener('touchstart', onUserActivity);
      window.removeEventListener('keydown', onUserActivity);
      clearHudAutoHideTimer();
    };
  }, [autoHideHudWhileRunning, clearHudAutoHideTimer, hudHiddenByUser, menuOpen, status, wizardOpen]);

  const buildCurrentPlayUrlWithSlot = useCallback(
    (slotId?: string): string => {
      if (!decodedRomId) {
        return '/';
      }
      const params = new URLSearchParams(searchParams);
      if (slotId) {
        params.set('saveSlot', slotId);
      } else {
        params.delete('saveSlot');
      }
      const query = params.toString();
      return `/play/${encodeURIComponent(decodedRomId)}${query ? `?${query}` : ''}`;
    },
    [decodedRomId, searchParams],
  );

  const refreshCurrentSaveSlots = useCallback(async (): Promise<SaveSlotRecord[]> => {
    if (!saveGameIdentity) {
      return [];
    }
    const refreshed = await listSaveSlotsForGame(saveGameIdentity.gameKey);
    setSaveSlots(refreshed);
    return refreshed;
  }, [saveGameIdentity]);

  const persistRuntimeSaveMetadata = useCallback(
    async (showToast: boolean): Promise<boolean> => {
      if (!activeSaveSlotId || !saveGameIdentity || !activeSaveSlot) {
        return false;
      }

      const bytes = runtimeSaveBytes();
      if (!bytes || bytes.byteLength === 0) {
        return false;
      }

      try {
        await persistRuntimeSaveForSlot({
          slot: activeSaveSlot,
          bytes,
          authenticated: isAuthenticated,
        });
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : 'Cloud save sync unavailable.';
        console.warn(`Cloud save upload failed: ${message}`);
      }

      await markSaveSlotSaved(activeSaveSlotId);
      const refreshed = await refreshCurrentSaveSlots();
      if (showToast) {
        const active = refreshed.find((slot) => slot.slotId === activeSaveSlotId);
        setSaveActivityMessage(
          active ? `Saved "${active.slotName}" at ${new Date().toLocaleTimeString()}.` : `Saved at ${new Date().toLocaleTimeString()}.`,
        );
      }
      return true;
    },
    [activeSaveSlot, activeSaveSlotId, isAuthenticated, refreshCurrentSaveSlots, saveGameIdentity],
  );

  const onSaveNow = async (): Promise<void> => {
    setSavingState(true);
    try {
      const saved = await persistRuntimeSaveMetadata(true);
      if (!saved) {
        setSaveActivityMessage('No save data is available yet for this game.');
      }
    } finally {
      setSavingState(false);
    }
  };

  const onSwitchSaveSlot = async (slotId: string): Promise<void> => {
    if (!activeSaveSlot || !decodedRomId || slotId === activeSaveSlot.slotId) {
      return;
    }

    await persistRuntimeSaveMetadata(false);
    await touchSaveSlot(slotId);
    setSaveActivityMessage('Switching save slot and rebooting game…');
    navigate(buildCurrentPlayUrlWithSlot(slotId));
  };

  const onCreateSaveSlot = async (): Promise<void> => {
    if (!saveGameIdentity) {
      return;
    }

    const suggestedName = `Save ${saveSlots.length + 1}`;
    const requestedName = window.prompt('Name your new save slot', suggestedName);
    if (requestedName === null) {
      return;
    }

    await persistRuntimeSaveMetadata(false);
    const slot = await createSaveSlot(saveGameIdentity, {
      slotName: requestedName,
    });
    setSaveActivityMessage(`Created save slot "${slot.slotName}".`);
    navigate(buildCurrentPlayUrlWithSlot(slot.slotId));
  };

  const onRenameActiveSaveSlot = async (): Promise<void> => {
    if (!activeSaveSlot) {
      return;
    }
    const nextName = window.prompt('Rename active save slot', activeSaveSlot.slotName);
    if (nextName === null) {
      return;
    }
    await renameSaveSlot(activeSaveSlot.slotId, nextName);
    await refreshCurrentSaveSlots();
    setSaveActivityMessage('Renamed active save slot.');
  };

  const onDeleteActiveSaveSlot = async (): Promise<void> => {
    if (!activeSaveSlot || !saveGameIdentity) {
      return;
    }
    const confirmed = window.confirm(`Delete save slot "${activeSaveSlot.slotName}"?`);
    if (!confirmed) {
      return;
    }

    const remainingSlots = saveSlots.filter((slot) => slot.slotId !== activeSaveSlot.slotId);
    try {
      await deleteSlotSaveEverywhere({
        slot: activeSaveSlot,
        authenticated: isAuthenticated,
      });
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : 'Cloud save cleanup unavailable.';
      console.warn(`Cloud save cleanup failed: ${message}`);
    }
    if (remainingSlots.length === 0) {
      const replacement = await createSaveSlot(saveGameIdentity, {
        slotName: activeSaveSlot.slotName,
      });
      await deleteSaveSlot(activeSaveSlot.slotId);
      setSaveActivityMessage(`Deleted "${activeSaveSlot.slotName}" and created a fresh slot.`);
      navigate(buildCurrentPlayUrlWithSlot(replacement.slotId));
      return;
    }

    const fallbackSlot = remainingSlots[0];
    await deleteSaveSlot(activeSaveSlot.slotId);
    setSaveActivityMessage(`Deleted "${activeSaveSlot.slotName}". Switching to "${fallbackSlot.slotName}".`);
    navigate(buildCurrentPlayUrlWithSlot(fallbackSlot.slotId));
  };

  const onResetActiveSave = async (): Promise<void> => {
    if (!activeSaveSlotId || !activeSaveSlot) {
      return;
    }
    const confirmed = window.confirm('Reset active save data to a clean state?');
    if (!confirmed) {
      return;
    }

    const cleared = clearRuntimeSaveBytes();
    try {
      await deleteSlotSaveEverywhere({
        slot: activeSaveSlot,
        authenticated: isAuthenticated,
      });
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : 'Cloud save cleanup unavailable.';
      console.warn(`Cloud save cleanup failed: ${message}`);
    }
    await clearSaveSlotProgress(activeSaveSlotId);
    await refreshCurrentSaveSlots();
    setSaveActivityMessage(cleared ? 'Reset active save state.' : 'Reset slot metadata. Runtime save file was unavailable.');
  };

  const onExportSaveFile = async (): Promise<void> => {
    const bytes = runtimeSaveBytes();
    if (!bytes || bytes.byteLength === 0) {
      setSaveActivityMessage('No save data available to export yet.');
      return;
    }

    const fileName = [
      'warpdeck64',
      saveFileNameSegment(saveGameIdentity?.displayTitle ?? rom?.title ?? 'game'),
      saveFileNameSegment(activeSaveSlot?.slotName ?? 'save'),
    ].join('-');

    const safeBytes = new Uint8Array(bytes.byteLength);
    safeBytes.set(bytes);
    const blob = new Blob([safeBytes.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileName}.sav`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    await persistRuntimeSaveMetadata(false);
    setSaveActivityMessage('Exported active save file.');
  };

  const onOpenImportSaveFile = (): void => {
    saveFileInputRef.current?.click();
  };

  const onImportSaveFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeSaveSlotId) {
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const applied = writeRuntimeSaveBytes(bytes);
    if (!applied) {
      setSaveActivityMessage('Could not import save data into emulator runtime.');
      return;
    }

    await persistRuntimeSaveMetadata(false);
    await touchSaveSlot(activeSaveSlotId);
    await refreshCurrentSaveSlots();
    setSaveActivityMessage(`Imported save file "${file.name}".`);
  };

  useEffect(() => {
    if (saveAutosyncTimerRef.current !== null) {
      window.clearInterval(saveAutosyncTimerRef.current);
      saveAutosyncTimerRef.current = null;
    }

    if (status !== 'running' || !activeSaveSlotId) {
      return;
    }

    saveAutosyncTimerRef.current = window.setInterval(() => {
      void persistRuntimeSaveMetadata(false);
    }, SAVE_AUTOSYNC_INTERVAL_MS);

    return () => {
      if (saveAutosyncTimerRef.current !== null) {
        window.clearInterval(saveAutosyncTimerRef.current);
        saveAutosyncTimerRef.current = null;
      }
    };
  }, [activeSaveSlotId, persistRuntimeSaveMetadata, status]);

  useEffect(() => {
    return () => {
      void persistRuntimeSaveMetadata(false);
    };
  }, [persistRuntimeSaveMetadata]);

  const onPauseResume = (): void => {
    const emulator = window.EJS_emulator;
    if (!emulator) {
      return;
    }

    if (status === 'running') {
      void persistRuntimeSaveMetadata(false);
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
    void persistRuntimeSaveMetadata(false);
    const emulator = window.EJS_emulator;
    emulator?.gameManager?.restart?.();
  };

  const onVirtualControlChange = (control: N64ControlTarget, pressed: boolean): void => {
    const simulateInput = resolveEmulatorSimulateInput(window.EJS_emulator);
    if (!simulateInput) {
      return;
    }

    const inputIndex = N64_TARGET_TO_INPUT_INDEX[control];
    if (typeof inputIndex !== 'number') {
      return;
    }

    simulateInput(0, inputIndex, pressed ? 1 : 0);
  };

  const onVirtualAnalogChange = (x: number, y: number): void => {
    const simulateInput = resolveEmulatorSimulateInput(window.EJS_emulator);
    if (!simulateInput) {
      return;
    }

    simulateInput(0, N64_TARGET_TO_INPUT_INDEX.analog_right, x > 0 ? x * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(0, N64_TARGET_TO_INPUT_INDEX.analog_left, x < 0 ? -x * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(0, N64_TARGET_TO_INPUT_INDEX.analog_up, y > 0 ? y * N64_ANALOG_MAX_VALUE : 0);
    simulateInput(0, N64_TARGET_TO_INPUT_INDEX.analog_down, y < 0 ? -y * N64_ANALOG_MAX_VALUE : 0);
  };

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
    setWizardMode('create');
    setWizardTemplateProfile(undefined);
  };

  const openCreateWizard = (): void => {
    setWizardMode('create');
    setWizardTemplateProfile(
      createProfileTemplateId ? createPreconfiguredGamepadProfileTemplate(createProfileTemplateId) : undefined,
    );
    setWizardOpen(true);
    setMenuOpen(true);
  };

  const openEditWizard = (): void => {
    if (!activeProfile) {
      openCreateWizard();
      return;
    }
    setWizardMode('edit');
    setWizardTemplateProfile(undefined);
    setWizardOpen(true);
    setMenuOpen(true);
  };

  const openCloneWizard = (): void => {
    if (!activeProfile) {
      openCreateWizard();
      return;
    }
    setWizardMode('create');
    setWizardTemplateProfile(activeProfile);
    setWizardOpen(true);
    setMenuOpen(true);
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

  const onRetryBoot = useCallback((mode: EmulatorBootMode): void => {
    setStatus('loading');
    setError(undefined);
    setBootMode(mode);
    void setPreferredBootMode(mode);
    setBootNonce((value) => value + 1);
  }, []);

  const onClearCacheAndRetry = async (): Promise<void> => {
    setClearingCache(true);
    setStatus('loading');
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

  const onCopyErrorDetails = async (): Promise<void> => {
    if (!error) {
      return;
    }

    const details = [
      'WarpDeck 64 local play boot error',
      `ROM: ${rom?.title ?? decodedRomId ?? 'Unknown ROM'}`,
      `Boot mode: ${bootMode}`,
      `Renderer: ${backendLabel}`,
      `Core: ${coreLabel}`,
      `Error: ${error}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(details);
      setEmulatorWarning('Copied recovery details to clipboard.');
    } catch {
      setEmulatorWarning('Unable to copy recovery details automatically.');
    }
  };

  const onDismissError = (): void => {
    setError(undefined);
  };

  const onToggleHudVisibility = (): void => {
    setHudHiddenByUser((current) => !current);
    setHudAutoHidden(false);
  };

  const onRevealHud = (): void => {
    setHudHiddenByUser(false);
    setHudAutoHidden(false);
  };

  useEffect(() => {
    if (status === 'loading' || status === 'error') {
      wizardAutoPausedRef.current = false;
      return;
    }

    const emulator = window.EJS_emulator;
    if (!emulator) {
      return;
    }

    if (wizardOpen) {
      if (status === 'running') {
        emulator.pause?.();
        wizardAutoPausedRef.current = true;
        setStatus('paused');
      }
      return;
    }

    if (wizardAutoPausedRef.current && status === 'paused') {
      emulator.play?.();
      setStatus('running');
    }
    wizardAutoPausedRef.current = false;
  }, [status, wizardOpen]);

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
        setWizardTemplateProfile(undefined);
        return;
      }

      if (wizardOpen) {
        event.preventDefault();
        return;
      }

      if (event.code === 'Escape' && settingsModalOpen) {
        event.preventDefault();
        setSettingsModalOpen(false);
        return;
      }

      if (settingsModalOpen) {
        event.preventDefault();
        return;
      }

      if (event.code === 'Escape' && menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }

      if (event.code === 'Escape' && compactActionTrayOpen) {
        event.preventDefault();
        setCompactActionTrayOpen(false);
        return;
      }

      if (event.code === 'KeyO') {
        event.preventDefault();
        setHudAutoHidden(false);
        setCompactActionTrayOpen(false);
        setMenuOpen((value) => !value);
        return;
      }

      if (event.code === 'KeyY') {
        event.preventDefault();
        if (onlineRelayEnabled && isOnlineHost) {
          onStabilizeDegradedViewers();
        }
        return;
      }

      if (event.code === 'KeyH') {
        event.preventDefault();
        setHudHiddenByUser((value) => !value);
        setHudAutoHidden(false);
        setCompactActionTrayOpen(false);
        return;
      }

      if (event.code === 'KeyB' && status === 'error') {
        event.preventDefault();
        navigate(libraryRoute);
        return;
      }

      if (event.code === 'KeyT' && status === 'error') {
        event.preventDefault();
        if (!isCatalogMissingError) {
          onRetryBoot('auto');
        } else {
          navigate(libraryRoute);
        }
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
        setHudAutoHidden(false);
      }
    };

    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
    };
  }, [
    compactActionTrayOpen,
    isCatalogMissingError,
    isOnlineHost,
    libraryRoute,
    menuOpen,
    navigate,
    onRetryBoot,
    onStabilizeDegradedViewers,
    onlineRelayEnabled,
    settingsModalOpen,
    status,
    wizardOpen,
  ]);

  useEffect(() => {
    if (!hasCompactHiddenActions && compactActionTrayOpen) {
      setCompactActionTrayOpen(false);
    }
  }, [compactActionTrayOpen, hasCompactHiddenActions]);

  useEffect(() => {
    if (menuOpen && compactActionTrayOpen) {
      setCompactActionTrayOpen(false);
    }
  }, [compactActionTrayOpen, menuOpen]);

  if (!decodedRomId) {
    return (
      <section className="panel">
        <p>Missing ROM id.</p>
        <Link to="/">Back to Library</Link>
      </section>
    );
  }

  const shortcutHint =
    status === 'error'
      ? isCatalogMissingError
        ? 'Shortcuts: B library • O menu • H HUD • Esc close overlays.'
        : 'Shortcuts: T retry auto • B library • O menu • H HUD • Esc close overlays.'
      : status === 'loading'
        ? 'Shortcuts: O menu • H HUD • Esc close overlays.'
        : onlineRelayEnabled && isOnlineHost
          ? 'Shortcuts: Space pause/resume • R reset • M map controller • O menu • H HUD • Y stabilize viewers • Esc close overlays.'
          : 'Shortcuts: Space pause/resume • R reset • M map controller • O menu • H HUD • Esc close overlays.';
  const activeProfileSummaryLabel = activeProfile?.name ?? 'None';
  const gameplaySectionVisible = !UX_PLAY_NAV_V2_ENABLED || activeMenuTab === 'gameplay';
  const savesSectionVisible = !UX_PLAY_NAV_V2_ENABLED || activeMenuTab === 'saves';
  const controlsSectionVisible = !UX_PLAY_NAV_V2_ENABLED || activeMenuTab === 'controls';
  const onlineSectionVisible = !UX_PLAY_NAV_V2_ENABLED || activeMenuTab === 'online';

  return (
    <section
      className={`play-page ${menuOpen ? 'play-menu-open' : ''} ${isCompactHudViewport ? 'play-compact-hud' : ''} ${
        compactActionTrayOpen ? 'play-compact-actions-open' : ''
      } ${showVirtualController ? 'play-has-virtual-controller' : ''} ${
        showVirtualController && virtualControllerMode === 'compact' ? 'play-virtual-compact' : ''
      }`}
    >
      <section
        ref={playStageRef}
        className={`play-stage ${hudVisible ? '' : 'play-stage-hud-hidden'} ${status === 'error' ? 'play-stage-error' : ''}`}
      >
        {hudVisible ? (
          <div className="play-overlay-top">
            <div className="play-overlay-left">
              <div className="play-primary-nav-strip">
                <nav className="app-header-nav play-primary-nav" aria-label="Primary">
                  <NavLink to={libraryRoute} end>
                    Library
                  </NavLink>
                  <NavLink to={onlineRoute}>Online</NavLink>
                  <button
                    type="button"
                    className="app-header-nav-button"
                    onClick={() => setSettingsModalOpen(true)}
                  >
                    Settings
                  </button>
                </nav>
                <button
                  type="button"
                  className="play-menu-toggle"
                  onClick={() => {
                    setCompactActionTrayOpen(false);
                    setMenuOpen((value) => !value);
                  }}
                >
                  {menuOpen ? 'Hide Menu' : 'Menu'}
                </button>
              </div>
              <div className="play-overlay-meta">
                <h1>{rom?.title ?? 'Loading ROM…'}</h1>
                <p>
                  <span className={statusClass}>{statusLabel}</span> • {playSessionLabel}
                </p>
              </div>
            </div>
            <div className={`play-overlay-actions ${inlineSecondaryActionsVisible ? 'expanded' : ''}`}>
              {isGameInteractive ? (
                <>
                  <button type="button" onClick={onPauseResume}>
                    {status === 'running' ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" onClick={onReset}>
                    Reset
                  </button>
                </>
              ) : null}
              {isGameInteractive ? (
                <button
                  type="button"
                  onClick={() => setShowVirtualController((value) => !value)}
                >
                  {showVirtualController ? 'Hide Virtual Pad' : 'Show Virtual Pad'}
                </button>
              ) : (
                <button type="button" disabled>
                  Virtual Pad Unavailable
                </button>
              )}
              <button
                type="button"
                className="play-action-secondary"
                onClick={onToggleHudVisibility}
              >
                {hudHiddenByUser ? 'Show HUD' : 'Hide HUD'}
              </button>
              {isGameInteractive ? (
                <button type="button" className="play-action-secondary" onClick={() => void onToggleFullscreen()}>
                  {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                </button>
              ) : null}
              {onlineRelayEnabled && isOnlineHost ? (
                <button type="button" className="play-action-secondary" onClick={onToggleHostChatAudioMute}>
                  {onlineHostChatVolume <= 0.001 ? 'Unmute Chat' : 'Mute Chat'}
                </button>
              ) : null}
              {onlineRelayEnabled && isOnlineHost ? (
                <button
                  type="button"
                  className={onlineHostVoiceInputMuted ? 'play-action-secondary' : undefined}
                  onClick={onToggleHostVoiceInputMuted}
                  disabled={!onlineVoiceEnabled || onlineHostVoiceMicRequesting}
                >
                  {!onlineVoiceEnabled
                    ? 'Voice Chat Off'
                    : onlineHostVoiceMicRequesting
                      ? 'Preparing Mic…'
                      : onlineHostVoiceInputMuted
                        ? 'Unmute Mic'
                        : 'Mute Mic'}
                </button>
              ) : null}
              {showVirtualController && isGameInteractive && isCompactHudViewport ? (
                <button type="button" className="play-action-secondary" onClick={() => setMenuOpen(true)}>
                  Pad Options
                </button>
              ) : null}
              {hasCompactHiddenActions ? (
                <button
                  type="button"
                  className="play-action-compact-only"
                  aria-expanded={compactActionTrayOpen}
                  onClick={() => setCompactActionTrayOpen((value) => !value)}
                >
                  {compactActionTrayOpen ? 'Less' : 'More'}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <button type="button" className="play-hud-reveal" onClick={onRevealHud}>
            Show HUD
          </button>
        )}

        <div className={`play-stage-surface ${status === 'error' ? 'play-stage-surface-error' : ''}`}>
          <div id="emulatorjs-player" className="ejs-player-host ejs-player-host-focus" aria-label="N64 emulator output" />
          {status === 'error' ? (
            <section className="play-error-panel" aria-live="polite">
              <h2>Unable to start this ROM</h2>
              <p className="error-text">{error ?? 'The emulator could not start this session.'}</p>
              {isCatalogMissingError ? (
                <p className="online-subtle">This ROM entry is missing. Go back to Library and re-import or re-index your game file.</p>
              ) : null}
              {!isCatalogMissingError ? (
                <p className="online-subtle">Try Auto first. If it fails again, switch Local/CDN or clear cache and retry.</p>
              ) : null}
              <div className="wizard-actions play-error-actions-primary">
                {!isCatalogMissingError ? (
                  <button type="button" onClick={() => onRetryBoot('auto')} disabled={clearingCache}>
                    Retry Auto
                  </button>
                ) : null}
                <button type="button" onClick={() => navigate(libraryRoute)}>
                  Back to Library
                </button>
                <button type="button" onClick={() => setMenuOpen(true)}>
                  Open Recovery Menu
                </button>
                <button type="button" onClick={onCopyErrorDetails}>
                  Copy Error
                </button>
                {!isCatalogMissingError ? (
                  <button type="button" onClick={() => setShowAdvancedRecoveryOptions((value) => !value)}>
                    {showAdvancedRecoveryOptions ? 'Hide Advanced Recovery' : 'More Recovery Options'}
                  </button>
                ) : null}
              </div>
              {!isCatalogMissingError && showAdvancedRecoveryOptions ? (
                <div className="wizard-actions play-error-actions-advanced">
                  <button type="button" onClick={() => onRetryBoot('local')} disabled={clearingCache}>
                    Retry Local
                  </button>
                  <button type="button" onClick={() => onRetryBoot('cdn')} disabled={clearingCache}>
                    Retry CDN
                  </button>
                  <button type="button" onClick={() => void onClearCacheAndRetry()} disabled={clearingCache}>
                    {clearingCache ? 'Clearing Cache…' : 'Clear Cache & Retry'}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {hudVisible || error || emulatorWarning ? (
          <div className="play-overlay-bottom">
            <p>{shortcutHint}</p>
            {!onlineRelayEnabled ? (
              profiles.length > 0 ? (
                <details ref={quickProfileSwitchRef} className="play-profile-quick-switch">
                  <summary>
                    <span className="play-profile-quick-switch-summary-label">Applied controller profile:</span>
                    <span className="play-profile-quick-switch-summary-value">{activeProfileSummaryLabel}</span>
                    <span className="play-profile-quick-switch-summary-hint">Quick swap</span>
                  </summary>
                  <div className="play-profile-quick-switch-panel">
                    <label htmlFor="play-overlay-profile-switcher">Quick swap profile</label>
                    <select
                      id="play-overlay-profile-switcher"
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
              )
            ) : null}
            {error && status !== 'error' ? (
              <div className="play-inline-error">
                <p className="error-text">{error}</p>
                <div className="wizard-actions">
                  <button type="button" onClick={onCopyErrorDetails}>
                    Copy Error
                  </button>
                  <button type="button" onClick={onDismissError}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}
            {emulatorWarning ? <p className="warning-text">{emulatorWarning}</p> : null}
          </div>
        ) : null}
      </section>

      {menuOpen ? (
        <button
          type="button"
          className="play-menu-backdrop"
          aria-label="Close game menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      {menuOpen ? (
        <aside className="play-side-menu open" aria-label="Play menu">
        <header className="play-side-header">
          <h2>Game Menu</h2>
          <button type="button" onClick={() => setMenuOpen(false)}>
            Close
          </button>
        </header>

        {UX_PLAY_NAV_V2_ENABLED ? (
          <div className="play-menu-tabs" role="tablist" aria-label="Play menu sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeMenuTab === 'gameplay'}
              className={activeMenuTab === 'gameplay' ? 'online-input-active' : undefined}
              onClick={() => setActiveMenuTab('gameplay')}
            >
              Gameplay
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMenuTab === 'saves'}
              className={activeMenuTab === 'saves' ? 'online-input-active' : undefined}
              onClick={() => setActiveMenuTab('saves')}
            >
              Saves
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMenuTab === 'controls'}
              className={activeMenuTab === 'controls' ? 'online-input-active' : undefined}
              onClick={() => setActiveMenuTab('controls')}
            >
              Controls
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMenuTab === 'online'}
              className={activeMenuTab === 'online' ? 'online-input-active' : undefined}
              onClick={() => setActiveMenuTab('online')}
              disabled={!onlineRelayEnabled}
            >
              Online
            </button>
          </div>
        ) : null}

        {UX_PLAY_NAV_V2_ENABLED ? (
          <div className="play-save-health-row" aria-label="Save health">
            <span
              className={`status-pill ${
                saveSyncStatus.local === 'ready'
                  ? 'status-good'
                  : saveSyncStatus.local === 'working'
                    ? 'status-warn'
                    : 'status-bad'
              }`}
            >
              Local: {saveSyncStatus.local === 'ready' ? 'Ready' : saveSyncStatus.local === 'working' ? 'Syncing' : 'Issue'}
            </span>
            <span
              className={`status-pill ${
                saveSyncStatus.cloud === 'ready'
                  ? 'status-good'
                  : saveSyncStatus.cloud === 'working' || saveSyncStatus.cloud === 'local-only'
                    ? 'status-warn'
                    : 'status-bad'
              }`}
            >
              Cloud:{' '}
              {saveSyncStatus.cloud === 'ready'
                ? 'Synced'
                : saveSyncStatus.cloud === 'working'
                  ? 'Syncing'
                  : saveSyncStatus.cloud === 'local-only'
                    ? 'Local only'
                    : 'Sync failed'}
            </span>
          </div>
        ) : null}

        {gameplaySectionVisible ? (
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
            <button type="button" onClick={() => setSettingsModalOpen(true)}>
              Settings
            </button>
            <button type="button" onClick={onToggleHudVisibility}>
              {hudHiddenByUser ? 'Show HUD' : 'Hide HUD'}
            </button>
            <button type="button" onClick={() => setShowVirtualController((value) => !value)} disabled={!isGameInteractive}>
              {isGameInteractive
                ? showVirtualController
                  ? 'Hide Virtual Controller'
                  : 'Show Virtual Controller'
                : 'Virtual Controller Unavailable'}
            </button>
            {showVirtualController && isGameInteractive && !isCompactHudViewport ? (
              <button
                type="button"
                onClick={() => setVirtualControllerMode((value) => (value === 'full' ? 'compact' : 'full'))}
              >
                {virtualControllerMode === 'full' ? 'Compact Controller' : 'Expand Controller'}
              </button>
            ) : null}
            {onlineRelayEnabled && sessionRoute ? <Link to={sessionRoute}>Back to Session</Link> : null}
            {onlineRelayEnabled ? (
              <button type="button" onClick={() => void onCopyInviteLink()}>
                Copy Invite Link
              </button>
            ) : null}
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoHideHudWhileRunning}
              onChange={(event) => {
                setAutoHideHudWhileRunning(event.target.checked);
                if (!event.target.checked) {
                  setHudAutoHidden(false);
                }
              }}
            />
            Auto-hide HUD while game is running
          </label>
          <p className="online-subtle">Immersive shortcut: press <code>H</code> to hide/show HUD instantly.</p>
          </div>
        ) : null}

        {savesSectionVisible ? (
          <section className="play-side-section">
          <h3>Save Data</h3>
          <p className="online-subtle">
            Autosave is always on. Resuming this game uses the most recently active slot by default.
          </p>
          {saveGameIdentity ? (
            <p className="online-subtle">
              Game identity: <strong>{saveGameIdentity.displayTitle}</strong>
            </p>
          ) : null}
          {activeSaveSlot ? (
            <p className="online-subtle">
              Active slot: <strong>{activeSaveSlot.slotName}</strong>
              {activeSaveSlot.lastSavedAt ? ` • Last save ${new Date(activeSaveSlot.lastSavedAt).toLocaleString()}` : ' • No save yet'}
            </p>
          ) : (
            <p className="online-subtle">Preparing save slot…</p>
          )}
          {advancedSaveSlotsEnabled && saveSlots.length > 0 ? (
            <label>
              Save slot
              <select
                value={activeSaveSlotId ?? ''}
                onChange={(event) => void onSwitchSaveSlot(event.target.value)}
                disabled={status === 'loading' || status === 'error'}
              >
                {saveSlots.map((slot) => (
                  <option key={slot.slotId} value={slot.slotId}>
                    {slot.slotName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!advancedSaveSlotsEnabled ? (
            <p className="online-subtle">
              Advanced save tools are disabled in Settings. This keeps a simple console-like save flow.
            </p>
          ) : null}
          {advancedSaveSlotsEnabled ? (
            <div className="wizard-actions">
              <button type="button" onClick={() => void onSaveNow()} disabled={status === 'loading' || status === 'error' || savingState}>
                {savingState ? 'Saving…' : 'Save Now'}
              </button>
              <button type="button" onClick={() => void onExportSaveFile()} disabled={status === 'loading' || status === 'error'}>
                Export Save File
              </button>
              <button type="button" onClick={onOpenImportSaveFile} disabled={status === 'loading' || status === 'error'}>
                Import Save File
              </button>
              <button type="button" className="danger-button" onClick={() => void onResetActiveSave()} disabled={status === 'loading' || status === 'error'}>
                Reset Active Save
              </button>
            </div>
          ) : null}
          {advancedSaveSlotsEnabled ? (
            <div className="wizard-actions">
              <button type="button" onClick={() => void onCreateSaveSlot()} disabled={status === 'loading' || status === 'error'}>
                New Slot
              </button>
              <button type="button" onClick={() => void onRenameActiveSaveSlot()} disabled={!activeSaveSlot}>
                Rename Slot
              </button>
              <button type="button" className="danger-button" onClick={() => void onDeleteActiveSaveSlot()} disabled={!activeSaveSlot}>
                Delete Slot
              </button>
            </div>
          ) : null}
          {saveActivityMessage ? <p className="online-subtle">{saveActivityMessage}</p> : null}
          <input
            ref={saveFileInputRef}
            type="file"
            accept=".sav,.srm,.eep,.fla,.bin,.dat"
            onChange={(event) => void onImportSaveFile(event)}
            hidden
          />
          </section>
        ) : null}

        {onlineRelayEnabled && onlineSectionVisible ? (
          <section className="play-side-section">
            <h3>Online Status</h3>
            <div className="session-status-row">
              <span className={relayStatusClass(onlineRelayStatus)}>Relay: {onlineRelayStatus}</span>
              <span className="status-pill">Players: {onlineConnectedMembers}/4</span>
              <span className="status-pill">Remote events: {onlineRemoteEventsApplied}</span>
              {isOnlineHost ? <span className="status-pill">Blocked inputs: {onlineRemoteEventsBlocked}</span> : null}
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
              <>
                <div className="stream-quality-controls">
                  <h4>Audio Mix</h4>
                  <div className="online-audio-mix-controls">
                    <label htmlFor="host-game-volume-slider">
                      Game audio volume ({volumePercentLabel(onlineHostGameVolume)})
                    </label>
                    <input
                      id="host-game-volume-slider"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={onlineHostGameVolume}
                      onChange={onHostGameVolumeChange}
                    />
                    <label htmlFor="host-chat-volume-slider">
                      Chat audio volume ({volumePercentLabel(onlineHostChatVolume)})
                    </label>
                    <input
                      id="host-chat-volume-slider"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={onlineHostChatVolume}
                      onChange={onHostChatVolumeChange}
                    />
                  </div>
                  <div className="wizard-actions">
                    <button type="button" onClick={onToggleHostGameAudioMute}>
                      {onlineHostGameVolume <= 0.001 ? 'Unmute Game Audio' : 'Mute Game Audio'}
                    </button>
                    <button type="button" onClick={onToggleHostChatAudioMute}>
                      {onlineHostChatVolume <= 0.001 ? 'Unmute Chat Audio' : 'Mute Chat Audio'}
                    </button>
                    <button
                      type="button"
                      onClick={onToggleHostVoiceInputMuted}
                      disabled={!onlineVoiceEnabled || onlineHostVoiceMicRequesting}
                    >
                      {!onlineVoiceEnabled
                        ? 'Voice Chat Off'
                        : onlineHostVoiceMicRequesting
                          ? 'Preparing Mic…'
                          : onlineHostVoiceInputMuted
                            ? 'Unmute Mic'
                            : 'Mute Mic'}
                    </button>
                  </div>
                  {!onlineVoiceEnabled ? (
                    <p className="online-subtle">Lobby voice is disabled in room settings.</p>
                  ) : (
                    <p className="online-subtle">
                      Voice chat is enabled. Unmute your mic to talk with connected guests.
                    </p>
                  )}
                  <p className="online-subtle">
                    Game volume controls emulator output (and game stream mix). Chat volume controls incoming guest voice playback.
                  </p>
                  {onlineHostVoiceMicError ? <p className="warning-text">{onlineHostVoiceMicError}</p> : null}
                </div>
                <div className="stream-quality-controls">
                  <h4>Input Moderation</h4>
                  {onlineGuestMembers.length > 0 ? (
                    <>
                      <ul className="input-moderation-list">
                        {onlineGuestMembers.map((member) => {
                          const muted = onlineMutedInputClientIds.includes(member.clientId);
                          return (
                            <li key={member.clientId}>
                              <span>
                                Player {member.slot}: {member.name}
                                {member.connected ? ' • connected' : ' • disconnected'}
                                {member.connected && typeof member.pingMs === 'number' ? ' • ' : ''}
                                {member.connected && typeof member.pingMs === 'number' ? (
                                  <span className={relayPingClass(member.pingMs, member.connected)}>
                                    {member.pingMs}ms relay
                                  </span>
                                ) : null}
                              </span>
                              <button type="button" onClick={() => onToggleGuestInputMute(member.clientId)}>
                                {muted ? 'Unmute Input' : 'Mute Input'}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="wizard-actions">
                        <button type="button" onClick={onMuteAllGuestInputs}>
                          Mute All Guests
                        </button>
                        <button type="button" onClick={onUnmuteAllGuestInputs}>
                          Unmute All Guests
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="online-subtle">No guest players connected.</p>
                  )}
                </div>
                <div className="stream-quality-controls">
                  <label>
                    Stream mode
                    <select
                      value={onlineStreamQualityPreset}
                      onChange={(event) => setOnlineStreamQualityPreset(event.target.value as HostStreamQualityPreset)}
                    >
                      <option value="adaptive">Adaptive (Recommended)</option>
                      {Object.entries(HOST_STREAM_QUALITY_PROFILES).map(([presetKey, preset]) => (
                        <option key={presetKey} value={presetKey}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="online-subtle">
                    {onlineStreamQualityPreset === 'adaptive'
                      ? `Automatically tuned. Current mode: ${HOST_STREAM_QUALITY_PROFILES[effectiveOnlineStreamQualityPreset].label}.`
                      : HOST_STREAM_QUALITY_PROFILES[effectiveOnlineStreamQualityPreset].description}
                  </p>
                  <div className="wizard-actions">
                    <button type="button" onClick={onResyncAllGuestStreams} disabled={onlineStreamPeers === 0}>
                      Re-sync Guest Streams
                    </button>
                    {recommendedStreamPreset ? (
                      <button
                        type="button"
                        onClick={() => setOnlineStreamQualityPreset(recommendedStreamPreset)}
                      >
                        Apply Recommended Mode
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setShowOnlineHostAdvancedTools((value) => !value)}
                      aria-expanded={showOnlineHostAdvancedTools}
                    >
                      {showOnlineHostAdvancedTools ? 'Hide Advanced Host Tools' : 'Show Advanced Host Tools'}
                    </button>
                  </div>
                  {!showOnlineHostAdvancedTools ? (
                    <p className="online-subtle">
                      Advanced telemetry, per-viewer repair controls, and automation toggles are hidden for a cleaner host menu.
                    </p>
                  ) : null}
                </div>
                {showOnlineHostAdvancedTools ? (
                  <>
                    <div className="stream-quality-controls">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={onlineAutoApplyRecommendedPreset}
                          onChange={(event) => setOnlineAutoApplyRecommendedPreset(event.target.checked)}
                        />
                        Auto-apply health recommendations in manual mode
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={onlineAutoHealViewerLinks}
                          onChange={(event) => setOnlineAutoHealViewerLinks(event.target.checked)}
                        />
                        Auto-heal degraded viewer links after sustained poor telemetry
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={onlineAutoStabilizeViewerPressure}
                          onChange={(event) => setOnlineAutoStabilizeViewerPressure(event.target.checked)}
                        />
                        Auto-stabilize high viewer pressure
                      </label>
                    </div>
                    {onlineLastQualityHint ? (
                      <div className="stream-quality-request-card">
                        <p>
                          Player {onlineLastQualityHint.fromSlot} ({onlineLastQualityHint.fromName}) requested{' '}
                          <strong>{HOST_STREAM_QUALITY_PROFILES[onlineLastQualityHint.requestedPreset].label}</strong>{' '}
                          mode.
                        </p>
                        {onlineLastQualityHint.reason ? (
                          <p className="online-subtle">{onlineLastQualityHint.reason}</p>
                        ) : null}
                        <div className="wizard-actions">
                          <button
                            type="button"
                            onClick={onApplyRequestedStreamMode}
                            disabled={effectiveOnlineStreamQualityPreset === onlineLastQualityHint.requestedPreset}
                          >
                            Apply Requested Mode
                          </button>
                          <button type="button" onClick={() => setOnlineLastQualityHint(undefined)}>
                            Dismiss Request
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="session-status-row host-stream-telemetry-row">
                      <span className={hostStreamHealthAssessment.className}>
                        Health: {hostStreamHealthAssessment.label}
                      </span>
                      <span className="status-pill">
                        Active mode: {HOST_STREAM_QUALITY_PROFILES[effectiveOnlineStreamQualityPreset].label}
                      </span>
                      <span className="status-pill">
                        Bitrate:{' '}
                        {onlineHostStreamTelemetry.bitrateKbps !== undefined
                          ? `${onlineHostStreamTelemetry.bitrateKbps} kbps`
                          : 'Measuring…'}
                      </span>
                      <span className="status-pill">
                        FPS:{' '}
                        {onlineHostStreamTelemetry.fps !== undefined
                          ? `${onlineHostStreamTelemetry.fps.toFixed(1)}`
                          : 'Measuring…'}
                      </span>
                      <span className={streamMetricClass(onlineHostStreamTelemetry.rttMs, 70, 140)}>
                        Stream RTT:{' '}
                        {onlineHostStreamTelemetry.rttMs !== undefined
                          ? `${onlineHostStreamTelemetry.rttMs} ms`
                          : 'Measuring…'}
                      </span>
                      <span
                        className={
                          onlineHostStreamTelemetry.qualityLimitationReason &&
                          onlineHostStreamTelemetry.qualityLimitationReason !== 'none'
                            ? 'status-pill status-warn'
                            : 'status-pill'
                        }
                      >
                        Quality limit:{' '}
                        {onlineHostStreamTelemetry.qualityLimitationReason &&
                        onlineHostStreamTelemetry.qualityLimitationReason !== 'none'
                          ? onlineHostStreamTelemetry.qualityLimitationReason
                          : 'none'}
                      </span>
                    </div>
                    <div className="viewer-pressure-card">
                      <div className="session-status-row">
                        <span className={hostViewerPressureAssessment.className}>
                          Viewer Pressure: {hostViewerPressureAssessment.label}
                        </span>
                        <span className="status-pill">
                          Connected viewers: {hostViewerPressureAssessment.connectedViewerCount}
                        </span>
                        <span
                          className={
                            hostViewerPressureAssessment.degradedViewerCount > 0
                              ? 'status-pill status-warn'
                              : 'status-pill status-good'
                          }
                        >
                          Degraded viewers: {hostViewerPressureAssessment.degradedViewerCount}
                        </span>
                      </div>
                      <p className="online-subtle">{hostViewerPressureAssessment.detail}</p>
                      <p className="online-subtle">
                        Auto-stabilize: {onlineAutoStabilizeViewerPressure ? 'enabled' : 'disabled'}.
                      </p>
                      <div className="wizard-actions">
                        <button
                          type="button"
                          onClick={onStabilizeDegradedViewers}
                          disabled={hostViewerPressureAssessment.degradedViewerCount === 0}
                        >
                          Stabilize Degraded Viewers
                        </button>
                      </div>
                    </div>
                    <div className="stream-quality-controls">
                      <h4>Viewer Stream Links</h4>
                      {onlineHostViewerRows.length > 0 ? (
                        <ul className="viewer-stream-list">
                          {onlineHostViewerRows.map(({ member, telemetry, health, lastResyncAt }) => (
                            <li key={member.clientId}>
                              <div className="viewer-stream-main">
                                <span>
                                  Player {member.slot}: {member.name}
                                </span>
                                <span className={health.className}>{health.label}</span>
                                <span className={streamMetricClass(telemetry?.rttMs, 80, 160)}>
                                  RTT: {telemetry?.rttMs !== undefined ? `${telemetry.rttMs} ms` : 'Measuring…'}
                                </span>
                                <span className="status-pill">
                                  FPS: {telemetry?.fps !== undefined ? telemetry.fps.toFixed(1) : 'Measuring…'}
                                </span>
                                <span className="status-pill">
                                  Bitrate: {telemetry?.bitrateKbps !== undefined ? `${telemetry.bitrateKbps} kbps` : 'Measuring…'}
                                </span>
                                <span className="status-pill">
                                  Last resync: {formatElapsedFromNow(lastResyncAt)}
                                </span>
                              </div>
                              <div className="viewer-stream-actions">
                                <button
                                  type="button"
                                  onClick={() => onResyncViewerStream(member.clientId, `Player ${member.slot} (${member.name})`)}
                                  disabled={!member.connected || onlineResyncingViewerClientId === member.clientId}
                                >
                                  {onlineResyncingViewerClientId === member.clientId ? 'Re-syncing…' : 'Re-sync Player'}
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="online-subtle">No guest viewers assigned yet.</p>
                      )}
                    </div>
                    <p className="online-subtle">{hostStreamHealthAssessment.detail}</p>
                    <p className="online-subtle">
                      Host stream source: emulator canvas ({ONLINE_STREAM_CAPTURE_FPS} fps target,{' '}
                      {onlineHostStreamHasGameAudio ? 'game audio + video stream path' : 'video-first fallback path'}).
                    </p>
                  </>
                ) : null}
              </>
            ) : (
              <p className="warning-text">Only Player 1 host should run the emulator on this page.</p>
            )}
          </section>
        ) : null}

        {controlsSectionVisible ? (
          <section className="play-side-section">
          <h3>Controller Profiles</h3>
          {profiles.length === 0 ? <p>No profiles yet. Create one to map controls.</p> : null}
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
          ) : null}
          <label>
            New profile template
            <select value={createProfileTemplateId} onChange={(event) => setCreateProfileTemplateId(event.target.value)}>
              <option value="">Blank mapping (manual wizard)</option>
              {PRECONFIGURED_GAMEPAD_PROFILE_TEMPLATES.map((template) => (
                <option key={template.templateId} value={template.templateId}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
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
          {activeProfile ? (
            <p className="online-subtle">
              Active: {activeProfile.name} • Device {activeProfile.deviceId} • Deadzone {activeProfile.deadzone.toFixed(2)}
            </p>
          ) : null}
          </section>
        ) : null}

        {gameplaySectionVisible ? (
          <section className="play-side-section">
          <h3>Emulator Runtime</h3>
          <p>Renderer: {backendLabel}</p>
          <p>Core: {coreLabel}</p>
          <p>Boot mode: {bootMode === 'auto' ? 'Auto fallback' : bootMode === 'local' ? 'Local cores only' : 'CDN cores only'}</p>
          <p>First launch can take a few seconds while emulator assets initialize.</p>
          </section>
        ) : null}

        {gameplaySectionVisible && status === 'error' ? (
          <section className="play-side-section">
            <h3>Recovery</h3>
            {isCatalogMissingError ? (
              <p className="online-subtle">This ROM is no longer available in your catalog. Re-index or import it again from Library.</p>
            ) : null}
            <p className="online-subtle">
              {isCatalogMissingError ? (
                <>
                  Recovery shortcut: press <code>T</code> to return to Library.
                </>
              ) : (
                <>
                  Recovery shortcut: press <code>T</code> for auto retry.
                </>
              )}
            </p>
            <div className="wizard-actions">
              {!isCatalogMissingError ? (
                <button type="button" onClick={() => onRetryBoot('auto')} disabled={clearingCache}>
                  Retry (Auto)
                </button>
              ) : null}
              {!isCatalogMissingError ? (
                <button type="button" onClick={() => onRetryBoot('local')} disabled={clearingCache}>
                  Retry (Local)
                </button>
              ) : null}
              {!isCatalogMissingError ? (
                <button type="button" onClick={() => onRetryBoot('cdn')} disabled={clearingCache}>
                  Retry (CDN)
                </button>
              ) : null}
              {!isCatalogMissingError ? (
                <button type="button" onClick={() => void onClearCacheAndRetry()} disabled={clearingCache}>
                  {clearingCache ? 'Clearing Cache…' : 'Clear Cache & Retry'}
                </button>
              ) : null}
              <button type="button" onClick={onCopyErrorDetails}>
                Copy Error Details
              </button>
              <button type="button" onClick={() => navigate(libraryRoute)}>
                Back to Library
              </button>
            </div>
          </section>
        ) : null}
        </aside>
      ) : null}

      {shouldRenderVirtualController ? (
        <div className={`virtual-controller-dock ${virtualControllerBlocked ? 'virtual-controller-dock-disabled' : ''}`}>
          {virtualControllerOverlayBlocked ? (
            <p className="virtual-controller-dock-note">
              Virtual controller input is paused while menus are open.
            </p>
          ) : null}
          <VirtualController
            disabled={virtualControllerBlocked}
            mode={virtualControllerMode}
            onControlChange={onVirtualControlChange}
            onAnalogChange={onVirtualAnalogChange}
          />
        </div>
      ) : null}

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            romHash={rom?.hash}
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
        <InSessionSettingsModal
          title={onlineRelayEnabled ? 'Online Play Settings' : 'Local Play Settings'}
          onClose={() => setSettingsModalOpen(false)}
        />
      ) : null}
    </section>
  );
}
