import {
  CONTROL_LABELS,
  N64_MAPPING_ORDER,
  type InputBinding,
  type N64ControlTarget,
} from '../types/input';

export interface MappingWizardState {
  stepIndex: number;
  bindings: Partial<Record<N64ControlTarget, InputBinding>>;
  skippedTargets: N64ControlTarget[];
}

const KEYBOARD_PRESET_BINDINGS: Partial<Record<N64ControlTarget, InputBinding>> = {
  a: { source: 'keyboard', code: 'KeyX' },
  b: { source: 'keyboard', code: 'KeyC' },
  z: { source: 'keyboard', code: 'ShiftLeft' },
  start: { source: 'keyboard', code: 'Enter' },
  l: { source: 'keyboard', code: 'KeyQ' },
  r: { source: 'keyboard', code: 'KeyE' },
  dpad_up: { source: 'keyboard', code: 'ArrowUp' },
  dpad_down: { source: 'keyboard', code: 'ArrowDown' },
  dpad_left: { source: 'keyboard', code: 'ArrowLeft' },
  dpad_right: { source: 'keyboard', code: 'ArrowRight' },
  c_up: { source: 'keyboard', code: 'KeyI' },
  c_down: { source: 'keyboard', code: 'KeyK' },
  c_left: { source: 'keyboard', code: 'KeyJ' },
  c_right: { source: 'keyboard', code: 'KeyL' },
  analog_left: { source: 'keyboard', code: 'KeyA' },
  analog_right: { source: 'keyboard', code: 'KeyD' },
  analog_up: { source: 'keyboard', code: 'KeyW' },
  analog_down: { source: 'keyboard', code: 'KeyS' },
};

export function createKeyboardPresetBindings(): Partial<Record<N64ControlTarget, InputBinding>> {
  const bindings: Partial<Record<N64ControlTarget, InputBinding>> = {};

  for (const target of N64_MAPPING_ORDER) {
    const binding = KEYBOARD_PRESET_BINDINGS[target];
    if (!binding) {
      continue;
    }

    bindings[target] = { ...binding };
  }

  return bindings;
}

export function createInitialWizardState(
  bindings?: Partial<Record<N64ControlTarget, InputBinding>>,
): MappingWizardState {
  const initialBindings = bindings ?? {};
  const firstUnmappedIndex = N64_MAPPING_ORDER.findIndex((target) => !initialBindings[target]);
  const initialStepIndex = firstUnmappedIndex === -1 ? N64_MAPPING_ORDER.length : firstUnmappedIndex;

  return {
    stepIndex: initialStepIndex,
    bindings: initialBindings,
    skippedTargets: [],
  };
}

export function currentTarget(state: MappingWizardState): N64ControlTarget | null {
  if (state.stepIndex >= N64_MAPPING_ORDER.length) {
    return null;
  }
  return N64_MAPPING_ORDER[state.stepIndex];
}

export function isWizardComplete(state: MappingWizardState): boolean {
  return state.stepIndex >= N64_MAPPING_ORDER.length;
}

export function wizardProgress(state: MappingWizardState): number {
  return Math.round((Math.min(state.stepIndex, N64_MAPPING_ORDER.length) / N64_MAPPING_ORDER.length) * 100);
}

export function assignBindingAndAdvance(
  state: MappingWizardState,
  binding: InputBinding,
): MappingWizardState {
  const target = currentTarget(state);
  if (!target) {
    return state;
  }

  return {
    ...state,
    bindings: {
      ...state.bindings,
      [target]: binding,
    },
    stepIndex: state.stepIndex + 1,
  };
}

export function skipCurrentTarget(state: MappingWizardState): MappingWizardState {
  const target = currentTarget(state);
  if (!target) {
    return state;
  }

  return {
    ...state,
    skippedTargets: state.skippedTargets.includes(target)
      ? state.skippedTargets
      : [...state.skippedTargets, target],
    stepIndex: state.stepIndex + 1,
  };
}

export function goBack(state: MappingWizardState): MappingWizardState {
  return {
    ...state,
    stepIndex: Math.max(0, state.stepIndex - 1),
  };
}

export function resetWizard(): MappingWizardState {
  return createInitialWizardState();
}

export function applyKeyboardPreset(): MappingWizardState {
  return {
    stepIndex: N64_MAPPING_ORDER.length,
    bindings: createKeyboardPresetBindings(),
    skippedTargets: [],
  };
}

export function mappingSummary(state: MappingWizardState): Array<{ target: N64ControlTarget; label: string; bound: boolean }> {
  return N64_MAPPING_ORDER.map((target) => ({
    target,
    label: CONTROL_LABELS[target],
    bound: Boolean(state.bindings[target]),
  }));
}
