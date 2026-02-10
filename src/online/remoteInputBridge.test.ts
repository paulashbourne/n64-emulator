import { vi } from 'vitest';

import {
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
    expect(describeRemoteInputPayload(null)).toBe('unknown input');
  });
});
