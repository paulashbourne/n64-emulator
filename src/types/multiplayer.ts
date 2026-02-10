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

export interface GetSessionResponse {
  session: MultiplayerSessionSnapshot;
}

export interface MultiplayerDigitalInputPayload {
  kind: 'digital';
  control: N64ControlTarget;
  pressed: boolean;
}

export type MultiplayerInputPayload = MultiplayerDigitalInputPayload;

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
      type: 'pong';
      at: number;
    };
