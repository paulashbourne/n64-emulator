import type { N64InputState } from './input';

export type EmulatorRunState = 'idle' | 'ready' | 'loading' | 'running' | 'paused' | 'error';
export type CoreBackend = 'wasm' | 'mock';

export interface CoreInitRequest {
  requestId: string;
  type: 'core_init';
  wasmUrl?: string;
  audioSampleRate?: number;
}

export interface CoreInitResponse {
  requestId: string;
  type: 'core_init_ok';
  backend: CoreBackend;
  frameWidth: number;
  frameHeight: number;
}

export interface LoadRomRequest {
  requestId: string;
  type: 'load_rom';
  romHash: string;
  romTitle: string;
  romBuffer: ArrayBuffer;
  saveData?: ArrayBuffer;
}

export interface LoadRomResponse {
  requestId: string;
  type: 'load_rom_ok';
  romHash: string;
  saveBytesLoaded: number;
}

export interface StartRequest {
  requestId: string;
  type: 'start';
}

export interface PauseRequest {
  requestId: string;
  type: 'pause';
}

export interface ResetRequest {
  requestId: string;
  type: 'reset';
}

export interface SetInputStateRequest {
  requestId: string;
  type: 'set_input_state';
  inputState: N64InputState;
}

export interface FlushSaveRequest {
  requestId: string;
  type: 'flush_save';
}

export interface BasicAckResponse {
  requestId: string;
  type: 'ack';
  action: 'start' | 'pause' | 'reset' | 'set_input_state' | 'flush_save';
}

export interface CoreErrorResponse {
  requestId: string;
  type: 'core_error';
  message: string;
  recoverable: boolean;
}

export interface FrameReadyEvent {
  type: 'frame_ready';
  width: number;
  height: number;
  pixelBuffer: ArrayBuffer;
  timestamp: number;
  fps: number;
}

export interface SaveFlushEvent {
  type: 'save_flush';
  romHash: string;
  data: ArrayBuffer;
}

export interface CoreErrorEvent {
  type: 'core_runtime_error';
  message: string;
  recoverable: boolean;
}

export type CoreRequestMessage =
  | CoreInitRequest
  | LoadRomRequest
  | StartRequest
  | PauseRequest
  | ResetRequest
  | SetInputStateRequest
  | FlushSaveRequest;

export type CoreResponseMessage =
  | CoreInitResponse
  | LoadRomResponse
  | BasicAckResponse
  | CoreErrorResponse;

export type CoreEventMessage = FrameReadyEvent | SaveFlushEvent | CoreErrorEvent;

export type CoreMessageFromMain = CoreRequestMessage;
export type CoreMessageFromWorker = CoreResponseMessage | CoreEventMessage;

export interface AdapterEventHandlers {
  onFrame: (event: FrameReadyEvent) => void;
  onSave: (event: SaveFlushEvent) => void;
  onRuntimeError: (event: CoreErrorEvent) => void;
}
