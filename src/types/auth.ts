export interface AuthenticatedUser {
  userId: string;
  username: string;
  email: string;
  country: string;
  avatarUrl: string | null;
}

export type AuthStatus = 'loading' | 'authenticated' | 'guest';

export interface CloudSaveMetadata {
  romHash: string;
  slotId: string;
  gameKey?: string;
  gameTitle?: string;
  slotName?: string;
  updatedAt: number;
  byteLength: number;
}

export interface CloudSaveRecord extends CloudSaveMetadata {
  dataBase64: string;
}
