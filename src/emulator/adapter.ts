import type {
  AdapterEventHandlers,
  CoreErrorResponse,
  CoreEventMessage,
  CoreInitResponse,
  CoreMessageFromWorker,
  CoreResponseMessage,
  LoadRomResponse,
} from '../types/emulator';
import type { N64InputState } from '../types/input';

interface PendingRequest {
  resolve: (value: CoreResponseMessage) => void;
  reject: (reason: Error) => void;
  timeoutId: number;
}

export interface InitOptions {
  wasmUrl?: string;
}

export interface LoadRomOptions {
  romHash: string;
  romTitle: string;
  romBuffer: ArrayBuffer;
  saveData?: ArrayBuffer;
}

const REQUEST_TIMEOUT_MS = 15_000;

function isEventMessage(message: CoreMessageFromWorker): message is CoreEventMessage {
  return (
    message.type === 'frame_ready' ||
    message.type === 'save_flush' ||
    message.type === 'core_runtime_error'
  );
}

function asError(response: CoreErrorResponse): Error {
  return new Error(response.message);
}

export class EmulatorAdapter {
  private readonly worker: Worker;

  private requestCounter = 0;

  private pending = new Map<string, PendingRequest>();

  private handlers: Partial<AdapterEventHandlers> = {};

  constructor() {
    this.worker = new Worker(new URL('./coreWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<CoreMessageFromWorker>) => {
      this.onWorkerMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.handlers.onRuntimeError?.({
        type: 'core_runtime_error',
        message: event.message,
        recoverable: true,
      });
    };
  }

  setEventHandlers(handlers: Partial<AdapterEventHandlers>): void {
    this.handlers = {
      ...this.handlers,
      ...handlers,
    };
  }

  async init(options?: InitOptions): Promise<CoreInitResponse> {
    const response = await this.sendRequest({
      type: 'core_init',
      wasmUrl: options?.wasmUrl,
    });

    if (response.type !== 'core_init_ok') {
      throw new Error(`Unexpected init response: ${response.type}`);
    }

    return response;
  }

  async loadRom(options: LoadRomOptions): Promise<LoadRomResponse> {
    const response = await this.sendRequest(
      {
        type: 'load_rom',
        romHash: options.romHash,
        romTitle: options.romTitle,
        romBuffer: options.romBuffer,
        saveData: options.saveData,
      },
      [options.romBuffer, ...(options.saveData ? [options.saveData] : [])],
    );

    if (response.type !== 'load_rom_ok') {
      throw new Error(`Unexpected load response: ${response.type}`);
    }

    return response;
  }

  async start(): Promise<void> {
    await this.expectAck('start');
  }

  async pause(): Promise<void> {
    await this.expectAck('pause');
  }

  async reset(): Promise<void> {
    await this.expectAck('reset');
  }

  setInputState(inputState: N64InputState): void {
    const requestId = this.nextRequestId();
    this.worker.postMessage({
      requestId,
      type: 'set_input_state',
      inputState,
    });
  }

  async flushSave(): Promise<void> {
    await this.expectAck('flush_save');
  }

  dispose(): void {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error('Adapter disposed before request completed.'));
    });
    this.pending.clear();
    this.worker.terminate();
  }

  private onWorkerMessage(message: CoreMessageFromWorker): void {
    if (isEventMessage(message)) {
      if (message.type === 'frame_ready') {
        this.handlers.onFrame?.(message);
        return;
      }

      if (message.type === 'save_flush') {
        this.handlers.onSave?.(message);
        return;
      }

      this.handlers.onRuntimeError?.(message);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(message.requestId);
    window.clearTimeout(pending.timeoutId);

    if (message.type === 'core_error') {
      pending.reject(asError(message));
      return;
    }

    pending.resolve(message);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req:${this.requestCounter}:${Date.now()}`;
  }

  private async expectAck(action: 'start' | 'pause' | 'reset' | 'flush_save'): Promise<void> {
    const response = await this.sendRequest({ type: action });
    if (response.type !== 'ack' || response.action !== action) {
      throw new Error(`Unexpected ack response for ${action}.`);
    }
  }

  private sendRequest(
    payload:
      | { type: 'core_init'; wasmUrl?: string }
      | {
          type: 'load_rom';
          romHash: string;
          romTitle: string;
          romBuffer: ArrayBuffer;
          saveData?: ArrayBuffer;
        }
      | { type: 'start' }
      | { type: 'pause' }
      | { type: 'reset' }
      | { type: 'flush_save' },
    transfer?: Transferable[],
  ): Promise<CoreResponseMessage> {
    const requestId = this.nextRequestId();

    return new Promise<CoreResponseMessage>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request timed out: ${payload.type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timeoutId });

      const message = {
        requestId,
        ...payload,
      };

      if (transfer && transfer.length > 0) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    });
  }
}
