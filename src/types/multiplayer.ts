import type { N64ControlTarget } from './input';

export interface MultiplayerMember {
  clientId: string;
  name: string;
  slot: number;
  isHost: boolean;
  connected: boolean;
  joinedAt: number;
}

export interface MultiplayerSessionSnapshot {
  code: string;
  createdAt: number;
  hostClientId: string;
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

export interface GetSessionResponse {
  session: MultiplayerSessionSnapshot;
}

export interface MultiplayerDigitalInputPayload {
  kind: 'digital';
  control: N64ControlTarget;
  pressed: boolean;
}

export type MultiplayerInputPayload = MultiplayerDigitalInputPayload;

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
      type: 'remote_input';
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
      type: 'session_closed';
      reason: string;
      at: number;
    }
  | {
      type: 'pong';
      at: number;
    };
