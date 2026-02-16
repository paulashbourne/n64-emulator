import type { N64ControlTarget } from './input';

export interface MultiplayerMember {
  clientId: string;
  name: string;
  avatarUrl?: string;
  slot: number;
  isHost: boolean;
  connected: boolean;
  ready: boolean;
  pingMs?: number;
  joinedAt: number;
}

export interface MultiplayerSessionSnapshot {
  code: string;
  createdAt: number;
  hostClientId: string;
  joinLocked: boolean;
  voiceEnabled: boolean;
  mutedInputClientIds: string[];
  romId?: string;
  romTitle?: string;
  members: MultiplayerMember[];
  chat: MultiplayerChatEntry[];
}

export interface CreateSessionResponse {
  code: string;
  clientId: string;
  session: MultiplayerSessionSnapshot;
}

export interface JoinSessionResponse {
  code: string;
  clientId: string;
  session: MultiplayerSessionSnapshot;
}

export interface CloseSessionResponse {
  closed: true;
  code: string;
}

export interface KickMemberResponse {
  kicked: true;
  code: string;
  targetClientId: string;
}

export interface GetSessionResponse {
  session: MultiplayerSessionSnapshot;
}

export interface MultiplayerDigitalInputPayload {
  kind: 'digital';
  control: N64ControlTarget;
  pressed: boolean;
}

export interface MultiplayerAnalogInputPayload {
  kind: 'analog';
  x: number;
  y: number;
}

export type MultiplayerInputPayload = MultiplayerDigitalInputPayload | MultiplayerAnalogInputPayload;
export type HostStreamQualityPresetHint = 'ultra_low_latency' | 'balanced' | 'quality';

export type MultiplayerWebRtcSignalPayload =
  | {
      kind: 'offer';
      sdp: string;
    }
  | {
      kind: 'answer';
      sdp: string;
    }
  | {
      kind: 'ice_candidate';
      candidate: RTCIceCandidateInit;
    };

export interface MultiplayerChatEntry {
  id: string;
  fromClientId: string;
  fromName: string;
  fromSlot: number;
  message: string;
  at: number;
}

export type MultiplayerSocketMessage =
  | {
      type: 'connected';
      clientId: string;
      slot: number;
      isHost: boolean;
    }
  | {
      type: 'room_state';
      session: MultiplayerSessionSnapshot;
    }
  | {
      type: 'member_latency';
      clientId: string;
      pingMs?: number;
      at: number;
    }
  | {
      type: 'remote_input';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      payload: MultiplayerInputPayload | null;
      at: number;
    }
  | {
      type: 'remote_input_reset';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      reason?: 'muted' | 'slot_changed' | 'member_disconnected' | 'member_removed';
      at: number;
    }
  | {
      type: 'input_blocked';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      payload: MultiplayerInputPayload | null;
      at: number;
    }
  | {
      type: 'chat';
      entry: MultiplayerChatEntry;
    }
  | {
      type: 'webrtc_signal';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      payload: MultiplayerWebRtcSignalPayload;
      at: number;
    }
  | {
      type: 'stream_resync_request';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      at: number;
    }
  | {
      type: 'quality_hint';
      fromClientId: string;
      fromName: string;
      fromSlot: number;
      requestedPreset: HostStreamQualityPresetHint;
      reason?: string;
      at: number;
    }
  | {
      type: 'session_closed';
      reason: string;
      at: number;
    }
  | {
      type: 'kicked';
      reason: string;
      byName: string;
      at: number;
    }
  | {
      type: 'pong';
      at: number;
    };
