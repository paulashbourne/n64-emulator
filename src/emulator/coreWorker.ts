/// <reference lib="webworker" />

import type {
  BasicAckResponse,
  CoreErrorEvent,
  CoreErrorResponse,
  CoreInitRequest,
  CoreInitResponse,
  CoreMessageFromMain,
  CoreMessageFromWorker,
  FlushSaveRequest,
  FrameReadyEvent,
  LoadRomRequest,
  LoadRomResponse,
} from '../types/emulator';
import { DEFAULT_N64_INPUT_STATE, type N64InputState } from '../types/input';

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const FRAME_TIME_MS = 1000 / 60;

interface RuntimeState {
  initialized: boolean;
  backend: 'wasm' | 'mock';
  running: boolean;
  romLoaded: boolean;
  romHash?: string;
  romTitle?: string;
  inputState: N64InputState;
  frameCounter: number;
  frameLoopHandle: number | null;
  saveData: Uint8Array;
  fpsWindowStart: number;
  fpsFrames: number;
  fpsCurrent: number;
}

const runtime: RuntimeState = {
  initialized: false,
  backend: 'mock',
  running: false,
  romLoaded: false,
  romHash: undefined,
  romTitle: undefined,
  inputState: {
    buttons: { ...DEFAULT_N64_INPUT_STATE.buttons },
    stick: { ...DEFAULT_N64_INPUT_STATE.stick },
  },
  frameCounter: 0,
  frameLoopHandle: null,
  saveData: new Uint8Array(),
  fpsWindowStart: performance.now(),
  fpsFrames: 0,
  fpsCurrent: 0,
};

function postMessageToMain(message: CoreMessageFromWorker, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerScope.postMessage(message, transfer);
    return;
  }
  workerScope.postMessage(message);
}

function postAck(requestId: string, action: BasicAckResponse['action']): void {
  const response: BasicAckResponse = {
    requestId,
    type: 'ack',
    action,
  };
  postMessageToMain(response);
}

function postRequestError(
  requestId: string,
  message: string,
  recoverable: boolean,
): void {
  const response: CoreErrorResponse = {
    requestId,
    type: 'core_error',
    message,
    recoverable,
  };
  postMessageToMain(response);
}

function postRuntimeError(message: string, recoverable: boolean): void {
  const event: CoreErrorEvent = {
    type: 'core_runtime_error',
    message,
    recoverable,
  };
  postMessageToMain(event);
}

async function tryLoadWasm(wasmUrl: string): Promise<boolean> {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      return false;
    }

    const wasmBuffer = await response.arrayBuffer();
    await WebAssembly.instantiate(wasmBuffer, {});
    return true;
  } catch {
    return false;
  }
}

function renderMockFrame(input: N64InputState, frameCounter: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  const pulse = Math.floor((Math.sin(frameCounter / 18) + 1) * 80);
  const stickXInfluence = Math.round((input.stick.x + 1) * 70);
  const stickYInfluence = Math.round((input.stick.y + 1) * 70);
  const aBoost = input.buttons.a ? 90 : 0;
  const bBoost = input.buttons.b ? 60 : 0;

  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const offset = (y * FRAME_WIDTH + x) * 4;

      const red = (x + pulse + stickXInfluence + aBoost) % 255;
      const green = (y + pulse + stickYInfluence + bBoost) % 255;
      const blue = (x + y + frameCounter * 2) % 255;

      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

function toTransferableBuffer(bytes: Uint8Array | Uint8ClampedArray): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return clone.buffer;
}

function updateFps(): number {
  runtime.fpsFrames += 1;
  const now = performance.now();
  const elapsed = now - runtime.fpsWindowStart;
  if (elapsed >= 1_000) {
    runtime.fpsCurrent = Math.round((runtime.fpsFrames / elapsed) * 1_000);
    runtime.fpsFrames = 0;
    runtime.fpsWindowStart = now;
  }
  return runtime.fpsCurrent;
}

function emitFrame(): void {
  if (!runtime.running || !runtime.romLoaded) {
    return;
  }

  runtime.frameCounter += 1;

  const pixels = renderMockFrame(runtime.inputState, runtime.frameCounter);
  const pixelBuffer = toTransferableBuffer(pixels);
  const event: FrameReadyEvent = {
    type: 'frame_ready',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    pixelBuffer,
    timestamp: performance.now(),
    fps: updateFps(),
  };

  postMessageToMain(event, [pixelBuffer]);
}

function stopFrameLoop(): void {
  if (runtime.frameLoopHandle !== null) {
    clearInterval(runtime.frameLoopHandle);
    runtime.frameLoopHandle = null;
  }
  runtime.running = false;
}

function startFrameLoop(): void {
  stopFrameLoop();
  runtime.running = true;
  runtime.frameLoopHandle = setInterval(emitFrame, FRAME_TIME_MS);
}

function copyInputState(nextState: N64InputState): N64InputState {
  return {
    buttons: { ...nextState.buttons },
    stick: {
      x: nextState.stick.x,
      y: nextState.stick.y,
    },
  };
}

function buildSaveBlob(): Uint8Array {
  const payload = JSON.stringify({
    romHash: runtime.romHash,
    frameCounter: runtime.frameCounter,
    timestamp: Date.now(),
  });
  return new TextEncoder().encode(payload);
}

async function handleInit(message: CoreInitRequest): Promise<void> {
  const wasmUrl = message.wasmUrl ?? '/cores/n64/n64core.wasm';
  const wasmLoaded = await tryLoadWasm(wasmUrl);

  runtime.initialized = true;
  runtime.backend = wasmLoaded ? 'wasm' : 'mock';

  const response: CoreInitResponse = {
    requestId: message.requestId,
    type: 'core_init_ok',
    backend: runtime.backend,
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
  };
  postMessageToMain(response);
}

function handleLoadRom(message: LoadRomRequest): void {
  if (!runtime.initialized) {
    postRequestError(message.requestId, 'Core must be initialized before loading a ROM.', false);
    return;
  }

  runtime.romLoaded = true;
  runtime.romHash = message.romHash;
  runtime.romTitle = message.romTitle;
  runtime.frameCounter = 0;
  runtime.inputState = {
    buttons: { ...DEFAULT_N64_INPUT_STATE.buttons },
    stick: { ...DEFAULT_N64_INPUT_STATE.stick },
  };

  runtime.saveData = message.saveData ? new Uint8Array(message.saveData) : new Uint8Array();

  const response: LoadRomResponse = {
    requestId: message.requestId,
    type: 'load_rom_ok',
    romHash: message.romHash,
    saveBytesLoaded: runtime.saveData.byteLength,
  };
  postMessageToMain(response);
}

function handleStart(requestId: string): void {
  if (!runtime.romLoaded) {
    postRequestError(requestId, 'No ROM loaded.', true);
    return;
  }

  startFrameLoop();
  postAck(requestId, 'start');
}

function handlePause(requestId: string): void {
  stopFrameLoop();
  postAck(requestId, 'pause');
}

function handleReset(requestId: string): void {
  runtime.frameCounter = 0;
  runtime.inputState = {
    buttons: { ...DEFAULT_N64_INPUT_STATE.buttons },
    stick: { ...DEFAULT_N64_INPUT_STATE.stick },
  };
  postAck(requestId, 'reset');
}

function handleSetInput(requestId: string, state: N64InputState): void {
  runtime.inputState = copyInputState(state);
  postAck(requestId, 'set_input_state');
}

function handleFlushSave(message: FlushSaveRequest): void {
  if (!runtime.romHash) {
    postRequestError(message.requestId, 'No ROM loaded for save flush.', true);
    return;
  }

  runtime.saveData = buildSaveBlob();
  const saveBuffer = toTransferableBuffer(runtime.saveData);

  postMessageToMain(
    {
      type: 'save_flush',
      romHash: runtime.romHash,
      data: saveBuffer,
    },
    [saveBuffer],
  );

  runtime.saveData = new Uint8Array();
  postAck(message.requestId, 'flush_save');
}

async function handleMessage(message: CoreMessageFromMain): Promise<void> {
  try {
    switch (message.type) {
      case 'core_init': {
        await handleInit(message);
        break;
      }
      case 'load_rom': {
        handleLoadRom(message);
        break;
      }
      case 'start': {
        handleStart(message.requestId);
        break;
      }
      case 'pause': {
        handlePause(message.requestId);
        break;
      }
      case 'reset': {
        handleReset(message.requestId);
        break;
      }
      case 'set_input_state': {
        handleSetInput(message.requestId, message.inputState);
        break;
      }
      case 'flush_save': {
        handleFlushSave(message);
        break;
      }
      default: {
        const neverMessage: never = message;
        postRuntimeError(`Unknown worker message: ${JSON.stringify(neverMessage)}`, true);
      }
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown worker error.';
    if ('requestId' in message) {
      postRequestError(message.requestId, messageText, true);
      return;
    }
    postRuntimeError(messageText, true);
  }
}

workerScope.onmessage = (event: MessageEvent<CoreMessageFromMain>): void => {
  void handleMessage(event.data);
};
