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
      payload: unknown;
      at: number;
    }
  | {
      type: 'pong';
      at: number;
    };
