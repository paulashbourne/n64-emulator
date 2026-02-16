import {
  CONTROL_LABELS,
  DEFAULT_N64_INPUT_STATE,
  isAnalogTarget,
  type AxisDirection,
  type ControllerProfile,
  type InputBinding,
  type N64ControlTarget,
  type N64DigitalTarget,
  type N64InputState,
} from '../types/input';

const BUTTON_PRESS_THRESHOLD = 0.6;
const DEFAULT_AXIS_THRESHOLD = 0.35;
const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
const HAT_AXIS_STEP = 1 / 7;
const HAT_AXIS_CAPTURE_SNAP_TOLERANCE = 0.09;
const DEFAULT_DISCRETE_AXIS_MATCH_TOLERANCE = 0.12;

function cloneDefaultInputState(): N64InputState {
  return {
    buttons: { ...DEFAULT_N64_INPUT_STATE.buttons },
    stick: { ...DEFAULT_N64_INPUT_STATE.stick },
  };
}

function detectDiscreteAxisValue(value: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) < 0.12 || Math.abs(value) > 1) {
    return null;
  }

  const snapped = Math.round(value / HAT_AXIS_STEP) * HAT_AXIS_STEP;
  if (Math.abs(value - snapped) > HAT_AXIS_CAPTURE_SNAP_TOLERANCE) {
    return null;
  }

  return Number(snapped.toFixed(6));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeAxisMagnitude(raw: number, threshold: number): number {
  if (raw <= threshold) {
    return 0;
  }
  return clamp((raw - threshold) / (1 - threshold), 0, 1);
}

function applyDeadzone(value: number, deadzone: number): number {
  const absolute = Math.abs(value);
  if (absolute <= deadzone) {
    return 0;
  }

  const scaled = (absolute - deadzone) / (1 - deadzone);
  return Math.sign(value) * clamp(scaled, 0, 1);
}

export function bindingToLabel(binding: InputBinding): string {
  if (binding.source === 'keyboard') {
    return `Keyboard ${binding.code ?? 'Unknown'}`;
  }

  if (binding.source === 'gamepad_button') {
    return `Gamepad Button ${binding.index ?? '?'}${binding.deviceId ? ` (${binding.deviceId})` : ''}`;
  }

  if (typeof binding.axisValue === 'number') {
    return `Gamepad Axis ${binding.index ?? '?'} = ${binding.axisValue.toFixed(2)}${binding.deviceId ? ` (${binding.deviceId})` : ''}`;
  }

  const direction = binding.direction === 'negative' ? '-' : '+';
  return `Gamepad Axis ${binding.index ?? '?'} ${direction}${binding.deviceId ? ` (${binding.deviceId})` : ''}`;
}

export interface CaptureNextInputOptions {
  allowKeyboard?: boolean;
  axisThreshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  preferDiscreteAxes?: boolean;
  waitForReleaseBinding?: InputBinding;
}

type GamepadSnapshot = {
  buttons: number[];
  axes: number[];
  id: string;
};

function readGamepads(): Gamepad[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return [];
  }
  return Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => Boolean(pad));
}

function captureSnapshot(gamepads: Gamepad[]): Map<number, GamepadSnapshot> {
  const map = new Map<number, GamepadSnapshot>();
  for (const pad of gamepads) {
    map.set(pad.index, {
      buttons: pad.buttons.map((button) => button.value),
      axes: [...pad.axes],
      id: pad.id,
    });
  }
  return map;
}

function axisDirection(value: number): AxisDirection {
  return value >= 0 ? 'positive' : 'negative';
}

function resolveGamepadForBinding(binding: InputBinding, gamepads: Gamepad[]): Gamepad | undefined {
  if (typeof binding.gamepadIndex === 'number') {
    const byIndex = gamepads.find((pad) => pad.index === binding.gamepadIndex);
    if (byIndex) {
      return byIndex;
    }
  }

  if (binding.deviceId) {
    const byDeviceId = gamepads.find((pad) => pad.id === binding.deviceId);
    if (byDeviceId) {
      return byDeviceId;
    }
  }

  if (gamepads.length === 1) {
    return gamepads[0];
  }

  return undefined;
}

function getBindingMagnitude(
  binding: InputBinding,
  keySet: Set<string>,
  gamepadsOverride?: Gamepad[],
): number {
  if (binding.source === 'keyboard') {
    return binding.code && keySet.has(binding.code) ? 1 : 0;
  }

  const gamepads = gamepadsOverride ?? readGamepads();
  const gamepad = resolveGamepadForBinding(binding, gamepads);
  if (!gamepad) {
    return 0;
  }

  if (binding.source === 'gamepad_button') {
    const value = gamepad.buttons[binding.index ?? -1]?.value ?? 0;
    return value >= BUTTON_PRESS_THRESHOLD ? value : 0;
  }

  if (typeof binding.axisValue === 'number') {
    const axisValue = gamepad.axes[binding.index ?? -1] ?? 0;
    const tolerance = binding.axisTolerance ?? DEFAULT_DISCRETE_AXIS_MATCH_TOLERANCE;
    return Math.abs(axisValue - binding.axisValue) <= tolerance ? 1 : 0;
  }

  const axisValue = gamepad.axes[binding.index ?? -1] ?? 0;
  const threshold = binding.threshold ?? DEFAULT_AXIS_THRESHOLD;
  const directed = binding.direction === 'negative' ? Math.max(0, -axisValue) : Math.max(0, axisValue);
  return normalizeAxisMagnitude(directed, threshold);
}

function evaluateDigitalTarget(
  target: N64DigitalTarget,
  profile: ControllerProfile,
  keySet: Set<string>,
): boolean {
  const binding = profile.bindings[target];
  if (!binding) {
    return false;
  }

  return getBindingMagnitude(binding, keySet) > 0;
}

function evaluateAnalogAxis(
  negativeBinding: InputBinding | undefined,
  positiveBinding: InputBinding | undefined,
  keySet: Set<string>,
): number {
  const negative = negativeBinding ? getBindingMagnitude(negativeBinding, keySet) : 0;
  const positive = positiveBinding ? getBindingMagnitude(positiveBinding, keySet) : 0;
  return clamp(positive - negative, -1, 1);
}

export function buildInputStateFromProfile(
  profile: ControllerProfile,
  keySet: Set<string>,
): N64InputState {
  const deadzone = clamp(profile.deadzone, 0, 0.95);
  const state = cloneDefaultInputState();

  (Object.keys(state.buttons) as N64DigitalTarget[]).forEach((target) => {
    state.buttons[target] = evaluateDigitalTarget(target, profile, keySet);
  });

  const rawX = evaluateAnalogAxis(profile.bindings.analog_left, profile.bindings.analog_right, keySet);
  const rawY = evaluateAnalogAxis(profile.bindings.analog_down, profile.bindings.analog_up, keySet);

  state.stick.x = applyDeadzone(rawX, deadzone);
  state.stick.y = applyDeadzone(rawY, deadzone);

  return state;
}

export async function captureNextInput(options?: CaptureNextInputOptions): Promise<InputBinding> {
  const axisThreshold = options?.axisThreshold ?? DEFAULT_AXIS_THRESHOLD;
  const allowKeyboard = options?.allowKeyboard ?? true;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const signal = options?.signal;
  const preferDiscreteAxes = options?.preferDiscreteAxes ?? true;
  const waitForReleaseBinding = options?.waitForReleaseBinding;

  return new Promise<InputBinding>((resolve, reject) => {
    let frameHandle: number | null = null;
    let timeoutHandle: number | null = null;
    let settled = false;
    const pressedKeyboardKeys = new Set<string>();
    let waitingForRelease = Boolean(waitForReleaseBinding);

    const initialGamepads = readGamepads();
    const previousSnapshot = captureSnapshot(initialGamepads);

    const cleanup = (): void => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('keyup', onKeyup, true);
      signal?.removeEventListener('abort', onAbort);
    };

    const createAbortError = (): Error => {
      const error = new Error('Input capture cancelled.');
      error.name = 'AbortError';
      return error;
    };

    const complete = (binding: InputBinding): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(binding);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      fail(createAbortError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    const onKeydown = (event: KeyboardEvent): void => {
      if (!allowKeyboard) {
        return;
      }
      pressedKeyboardKeys.add(event.code);
      if (waitingForRelease || event.repeat) {
        return;
      }
      event.preventDefault();
      complete({
        source: 'keyboard',
        code: event.code,
      });
    };

    const onKeyup = (event: KeyboardEvent): void => {
      if (!allowKeyboard) {
        return;
      }
      pressedKeyboardKeys.delete(event.code);
    };

    const isWaitingBindingReleased = (pads: Gamepad[]): boolean => {
      if (!waitForReleaseBinding) {
        return false;
      }
      return getBindingMagnitude(waitForReleaseBinding, pressedKeyboardKeys, pads) > 0;
    };

    const poll = (): void => {
      const pads = readGamepads();
      const connectedPadIndices = new Set<number>();
      if (waitingForRelease && isWaitingBindingReleased(pads)) {
        for (const pad of pads) {
          previousSnapshot.set(pad.index, {
            buttons: pad.buttons.map((button) => button.value),
            axes: [...pad.axes],
            id: pad.id,
          });
        }
        frameHandle = requestAnimationFrame(poll);
        return;
      }
      waitingForRelease = false;

      for (const pad of pads) {
        connectedPadIndices.add(pad.index);

        const lastSnapshot = previousSnapshot.get(pad.index);
        const previousButtons = lastSnapshot?.buttons ?? [];
        const previousAxes = lastSnapshot?.axes ?? [];

        for (let buttonIndex = 0; buttonIndex < pad.buttons.length; buttonIndex += 1) {
          const current = pad.buttons[buttonIndex]?.value ?? 0;
          const previous = previousButtons[buttonIndex] ?? 0;

          if (current >= BUTTON_PRESS_THRESHOLD && previous < BUTTON_PRESS_THRESHOLD) {
            complete({
              source: 'gamepad_button',
              index: buttonIndex,
              gamepadIndex: pad.index,
              deviceId: pad.id,
            });
            return;
          }
        }

        for (let axisIndex = 0; axisIndex < pad.axes.length; axisIndex += 1) {
          const current = pad.axes[axisIndex] ?? 0;
          const previous = previousAxes[axisIndex] ?? 0;

          if (preferDiscreteAxes) {
            const currentDiscreteValue = detectDiscreteAxisValue(current);
            const previousDiscreteValue = detectDiscreteAxisValue(previous);
            if (currentDiscreteValue !== null && currentDiscreteValue !== previousDiscreteValue) {
              complete({
                source: 'gamepad_axis',
                index: axisIndex,
                axisValue: currentDiscreteValue,
                axisTolerance: DEFAULT_DISCRETE_AXIS_MATCH_TOLERANCE,
                gamepadIndex: pad.index,
                deviceId: pad.id,
              });
              return;
            }
          }

          if (Math.abs(current) < axisThreshold || Math.abs(previous) >= axisThreshold) {
            continue;
          }

          complete({
            source: 'gamepad_axis',
            index: axisIndex,
            direction: axisDirection(current),
            threshold: axisThreshold,
            gamepadIndex: pad.index,
            deviceId: pad.id,
          });
          return;
        }

        previousSnapshot.set(pad.index, {
          buttons: pad.buttons.map((button) => button.value),
          axes: [...pad.axes],
          id: pad.id,
        });
      }

      for (const storedPadIndex of Array.from(previousSnapshot.keys())) {
        if (!connectedPadIndices.has(storedPadIndex)) {
          previousSnapshot.delete(storedPadIndex);
        }
      }

      frameHandle = requestAnimationFrame(poll);
    };

    timeoutHandle = window.setTimeout(() => {
      fail(new Error('Timed out waiting for input. Try pressing a button again.'));
    }, timeoutMs);

    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('keyup', onKeyup, true);
    signal?.addEventListener('abort', onAbort, { once: true });
    frameHandle = requestAnimationFrame(poll);
  });
}

export interface InputPoller {
  stop: () => void;
}

export function createInputPoller(
  profile: ControllerProfile,
  onInput: (state: N64InputState) => void,
): InputPoller {
  const pressedKeys = new Set<string>();
  let frameHandle: number | null = null;

  const onKeydown = (event: KeyboardEvent): void => {
    pressedKeys.add(event.code);
  };

  const onKeyup = (event: KeyboardEvent): void => {
    pressedKeys.delete(event.code);
  };

  const emit = (): void => {
    onInput(buildInputStateFromProfile(profile, pressedKeys));
    frameHandle = requestAnimationFrame(emit);
  };

  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keyup', onKeyup);
  frameHandle = requestAnimationFrame(emit);

  return {
    stop: () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('keyup', onKeyup);
    },
  };
}

export function controlPrompt(target: N64ControlTarget): string {
  if (isAnalogTarget(target)) {
    return `Move your stick or key for ${CONTROL_LABELS[target]}`;
  }
  return `Press the input for ${CONTROL_LABELS[target]}`;
}
