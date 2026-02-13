import { vi } from 'vitest';

import {
  applyRemoteInputResetToHost,
  applyRemoteInputPayloadToHost,
  describeRemoteInputPayload,
  parseRemoteInputPayload,
} from './remoteInputBridge';

describe('remote input bridge', () => {
  afterEach(() => {
    delete window.EJS_emulator;
  });

  test('parses a valid digital input payload and rejects malformed payloads', () => {
    expect(
      parseRemoteInputPayload({
        kind: 'digital',
        control: 'a',
        pressed: true,
      }),
    ).toEqual({
      kind: 'digital',
      control: 'a',
      pressed: true,
    });

    expect(parseRemoteInputPayload({ kind: 'digital', control: 'invalid', pressed: true })).toBeNull();
    expect(parseRemoteInputPayload({ kind: 'digital', control: 'a', pressed: 'yes' })).toBeNull();
    expect(
      parseRemoteInputPayload({
        kind: 'analog',
        x: 0.65,
        y: -0.4,
      }),
    ).toEqual({
      kind: 'analog',
      x: 0.65,
      y: -0.4,
    });
    expect(
      parseRemoteInputPayload({
        kind: 'analog',
        x: 2.7,
        y: -8,
      }),
    ).toEqual({
      kind: 'analog',
      x: 1,
      y: -1,
    });
    expect(parseRemoteInputPayload({ kind: 'analog', x: '0.5', y: 0.1 })).toBeNull();
    expect(parseRemoteInputPayload({ kind: 'analog', x: 0.1, y: '0.5' })).toBeNull();
    expect(parseRemoteInputPayload(null)).toBeNull();
  });

  test('routes player 2 remote input to emulator slot index 1', () => {
    const simulateInput = vi.fn();
    window.EJS_emulator = {
      gameManager: {
        functions: {
          simulateInput,
        },
      },
    };

    const applied = applyRemoteInputPayloadToHost({
      fromSlot: 2,
      payload: {
        kind: 'digital',
        control: 'a',
        pressed: true,
      },
    });

    expect(applied).toBe(true);
    expect(simulateInput).toHaveBeenCalledWith(1, 0, 1);
  });

  test('routes player 4 button release with direct gameManager simulateInput', () => {
    const simulateInput = vi.fn();
    window.EJS_emulator = {
      gameManager: {
        simulateInput,
      },
    };

    const applied = applyRemoteInputPayloadToHost({
      fromSlot: 4,
      payload: {
        kind: 'digital',
        control: 'dpad_left',
        pressed: false,
      },
    });

    expect(applied).toBe(true);
    expect(simulateInput).toHaveBeenCalledWith(3, 6, 0);
  });

  test('preserves gameManager context when using direct simulateInput method', () => {
    const gameManager = {
      calls: [] as Array<[number, number, number]>,
      simulateInput(this: { calls: Array<[number, number, number]> }, player: number, input: number, value: number) {
        this.calls.push([player, input, value]);
      },
    };
    window.EJS_emulator = {
      gameManager,
    };

    const applied = applyRemoteInputPayloadToHost({
      fromSlot: 2,
      payload: {
        kind: 'digital',
        control: 'a',
        pressed: true,
      },
    });

    expect(applied).toBe(true);
    expect(gameManager.calls).toEqual([[1, 0, 1]]);
  });

  test('routes player 3 analog payload to directional analog indexes', () => {
    const simulateInput = vi.fn();
    window.EJS_emulator = {
      gameManager: {
        simulateInput,
      },
    };

    const applied = applyRemoteInputPayloadToHost({
      fromSlot: 3,
      payload: {
        kind: 'analog',
        x: 0.5,
        y: -0.25,
      },
    });

    expect(applied).toBe(true);
    expect(simulateInput).toHaveBeenNthCalledWith(1, 2, 16, 16383.5);
    expect(simulateInput).toHaveBeenNthCalledWith(2, 2, 17, 0);
    expect(simulateInput).toHaveBeenNthCalledWith(3, 2, 19, 0);
    expect(simulateInput).toHaveBeenNthCalledWith(4, 2, 18, 8191.75);
  });

  test('preserves functions context when using nested simulateInput fallback', () => {
    const functions = {
      calls: [] as Array<[number, number, number]>,
      simulateInput(this: { calls: Array<[number, number, number]> }, player: number, input: number, value: number) {
        this.calls.push([player, input, value]);
      },
    };
    window.EJS_emulator = {
      gameManager: {
        functions,
      },
    };

    const applied = applyRemoteInputPayloadToHost({
      fromSlot: 2,
      payload: {
        kind: 'digital',
        control: 'b',
        pressed: false,
      },
    });

    expect(applied).toBe(true);
    expect(functions.calls).toEqual([[1, 1, 0]]);
  });

  test('ignores invalid slots and missing emulator hooks', () => {
    const simulateInput = vi.fn();
    window.EJS_emulator = {
      gameManager: {
        functions: {
          simulateInput,
        },
      },
    };

    expect(
      applyRemoteInputPayloadToHost({
        fromSlot: 1,
        payload: {
          kind: 'digital',
          control: 'b',
          pressed: true,
        },
      }),
    ).toBe(false);

    expect(simulateInput).not.toHaveBeenCalled();

    delete window.EJS_emulator;

    expect(
      applyRemoteInputPayloadToHost({
        fromSlot: 2,
        payload: {
          kind: 'digital',
          control: 'b',
          pressed: true,
        },
      }),
    ).toBe(false);
  });

  test('describes payloads for host telemetry', () => {
    expect(
      describeRemoteInputPayload({
        kind: 'digital',
        control: 'start',
        pressed: true,
      }),
    ).toBe('start down');
    expect(
      describeRemoteInputPayload({
        kind: 'analog',
        x: -0.4,
        y: 0.75,
      }),
    ).toBe('analog x -0.40 y 0.75');
    expect(describeRemoteInputPayload(null)).toBe('unknown input');
  });

  test('resets all mapped controls for a remote slot', () => {
    const simulateInput = vi.fn();
    window.EJS_emulator = {
      gameManager: {
        simulateInput,
      },
    };

    const reset = applyRemoteInputResetToHost(3);

    expect(reset).toBe(true);
    expect(simulateInput).toHaveBeenCalled();
    expect(simulateInput).toHaveBeenCalledWith(2, 0, 0);
    expect(simulateInput).toHaveBeenCalledWith(2, 17, 0);
    expect(simulateInput).toHaveBeenCalledWith(2, 23, 0);
  });
});
