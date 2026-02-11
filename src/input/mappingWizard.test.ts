import {
  applyKeyboardPreset,
  assignBindingAndAdvance,
  createKeyboardPresetBindings,
  createInitialWizardState,
  currentTarget,
  goBack,
  isWizardComplete,
  resetWizard,
  skipCurrentTarget,
  wizardProgress,
} from './mappingWizard';

describe('mapping wizard state machine', () => {
  test('advances through targets when binding is assigned', () => {
    let state = createInitialWizardState();
    expect(currentTarget(state)).toBe('a');

    state = assignBindingAndAdvance(state, { source: 'keyboard', code: 'KeyJ' });
    expect(currentTarget(state)).toBe('b');
    expect(state.bindings.a?.code).toBe('KeyJ');
    expect(wizardProgress(state)).toBeGreaterThan(0);
  });

  test('supports skip and back controls', () => {
    let state = createInitialWizardState();
    state = skipCurrentTarget(state);
    expect(currentTarget(state)).toBe('b');

    state = goBack(state);
    expect(currentTarget(state)).toBe('a');

    const reset = resetWizard();
    expect(reset.stepIndex).toBe(0);
    expect(Object.keys(reset.bindings)).toHaveLength(0);
  });

  test('marks completion once all targets are processed', () => {
    let state = createInitialWizardState();
    for (let index = 0; index < 18; index += 1) {
      state = skipCurrentTarget(state);
    }

    expect(isWizardComplete(state)).toBe(true);
    expect(currentTarget(state)).toBeNull();
  });

  test('can apply the keyboard preset and mark all targets as complete', () => {
    const state = applyKeyboardPreset();
    expect(isWizardComplete(state)).toBe(true);
    expect(state.bindings.analog_up?.code).toBe('KeyW');
    expect(state.bindings.analog_left?.code).toBe('KeyA');
    expect(state.bindings.a?.code).toBe('KeyX');
    expect(state.bindings.start?.code).toBe('Enter');
    expect(state.skippedTargets).toHaveLength(0);
  });

  test('keyboard preset bindings are cloned on each call', () => {
    const first = createKeyboardPresetBindings();
    const second = createKeyboardPresetBindings();
    expect(first).not.toBe(second);
    expect(first.a?.code).toBe('KeyX');
    expect(second.a?.code).toBe('KeyX');
  });
});
