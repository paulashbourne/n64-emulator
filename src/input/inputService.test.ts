import { vi } from 'vitest';

import { buildInputStateFromProfile, captureNextInput } from './inputService';
import type { ControllerProfile } from '../types/input';

function makeProfile(overrides?: Partial<ControllerProfile>): ControllerProfile {
  return {
    profileId: 'profile:test',
    name: 'Test Profile',
    deviceId: 'Pad 1',
    deadzone: 0.2,
    bindings: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

interface MockGamepadInput {
  id: string;
  index: number;
  axes: number[];
  buttons?: number[];
}

function toMockGamepad(pad: MockGamepadInput): Gamepad {
  return {
    id: pad.id,
    index: pad.index,
    axes: pad.axes,
    buttons: (pad.buttons ?? []).map((value) => ({
      value,
      pressed: value > 0.5,
      touched: value > 0,
    })),
  } as unknown as Gamepad;
}

function setMockGamepads(pads: MockGamepadInput[]): void {
  const mockPads = pads.map(toMockGamepad);
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => mockPads,
    writable: true,
    configurable: true,
  });
}

function setMockGamepadSequence(sequence: MockGamepadInput[]): void {
  let readCount = 0;
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => {
      const next = sequence[Math.min(readCount, sequence.length - 1)];
      readCount += 1;
      return [toMockGamepad(next)];
    },
    writable: true,
    configurable: true,
  });
}

async function flushAnimationFrames(queue: FrameRequestCallback[], count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const callback = queue.shift();
    if (!callback) {
      throw new Error('Expected animation frame callback in queue.');
    }
    callback(performance.now());
    await Promise.resolve();
  }
}

describe('input service', () => {
  const rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('maps keyboard bindings into digital N64 buttons', () => {
    const profile = makeProfile({
      bindings: {
        a: { source: 'keyboard', code: 'KeyJ' },
      },
    });

    const state = buildInputStateFromProfile(profile, new Set(['KeyJ']));
    expect(state.buttons.a).toBe(true);
    expect(state.buttons.b).toBe(false);
  });

  test('applies axis threshold before analog output', () => {
    const profile = makeProfile({
      deadzone: 0,
      bindings: {
        analog_right: {
          source: 'gamepad_axis',
          gamepadIndex: 0,
          index: 0,
          direction: 'positive',
          threshold: 0.4,
        },
      },
    });

    setMockGamepads([{ id: 'Pad 1', index: 0, axes: [0.45] }]);
    const lowState = buildInputStateFromProfile(profile, new Set());

    setMockGamepads([{ id: 'Pad 1', index: 0, axes: [0.7] }]);
    const highState = buildInputStateFromProfile(profile, new Set());

    expect(lowState.stick.x).toBeLessThan(highState.stick.x);
    expect(lowState.stick.x).toBeGreaterThan(0);
  });

  test('deadzone suppresses small stick values', () => {
    const profile = makeProfile({
      deadzone: 0.3,
      bindings: {
        analog_right: {
          source: 'gamepad_axis',
          gamepadIndex: 0,
          index: 0,
          direction: 'positive',
          threshold: 0.4,
        },
      },
    });

    setMockGamepads([{ id: 'Pad 1', index: 0, axes: [0.55] }]);
    const state = buildInputStateFromProfile(profile, new Set());
    expect(state.stick.x).toBe(0);
  });

  test('falls back to device id when gamepad index changes after reconnect', () => {
    const profile = makeProfile({
      deadzone: 0,
      bindings: {
        analog_right: {
          source: 'gamepad_axis',
          gamepadIndex: 0,
          deviceId: 'Pad Reconnected',
          index: 0,
          direction: 'positive',
          threshold: 0.2,
        },
      },
    });

    setMockGamepads([{ id: 'Pad Reconnected', index: 3, axes: [0.9] }]);
    const state = buildInputStateFromProfile(profile, new Set());

    expect(state.stick.x).toBeGreaterThan(0.8);
  });

  test('falls back to the single connected gamepad when profile metadata is incomplete', () => {
    const profile = makeProfile({
      deadzone: 0,
      bindings: {
        analog_right: {
          source: 'gamepad_axis',
          index: 0,
          direction: 'positive',
          threshold: 0.3,
        },
      },
    });

    setMockGamepads([{ id: 'Only Pad', index: 2, axes: [0.8] }]);
    const state = buildInputStateFromProfile(profile, new Set());

    expect(state.stick.x).toBeGreaterThan(0.6);
  });

  test('capture can detect a button press even if the button was held at capture start', async () => {
    setMockGamepadSequence([
      { id: 'Pad 1', index: 0, axes: [0], buttons: [1] },
      { id: 'Pad 1', index: 0, axes: [0], buttons: [0] },
      { id: 'Pad 1', index: 0, axes: [0], buttons: [1] },
    ]);

    const capturePromise = captureNextInput({
      allowKeyboard: false,
      timeoutMs: 500,
    });

    await flushAnimationFrames(rafQueue, 2);

    await expect(capturePromise).resolves.toMatchObject({
      source: 'gamepad_button',
      index: 0,
      gamepadIndex: 0,
      deviceId: 'Pad 1',
    });
  });

  test('capture can detect axis input after returning through neutral', async () => {
    setMockGamepadSequence([
      { id: 'Pad 1', index: 0, axes: [0.8], buttons: [] },
      { id: 'Pad 1', index: 0, axes: [0.05], buttons: [] },
      { id: 'Pad 1', index: 0, axes: [-0.85], buttons: [] },
    ]);

    const capturePromise = captureNextInput({
      allowKeyboard: false,
      timeoutMs: 500,
      axisThreshold: 0.35,
    });

    await flushAnimationFrames(rafQueue, 2);

    await expect(capturePromise).resolves.toMatchObject({
      source: 'gamepad_axis',
      index: 0,
      direction: 'negative',
      gamepadIndex: 0,
      deviceId: 'Pad 1',
    });
  });
});
