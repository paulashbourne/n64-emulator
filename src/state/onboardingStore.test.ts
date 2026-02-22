import { beforeEach, describe, expect, test } from 'vitest';

import {
  onboardingChecklistVisible,
  onboardingProgressPercent,
  useOnboardingStore,
} from './onboardingStore';

const ONBOARDING_PROGRESS_STORAGE_KEY = 'ux_onboarding_progress_v1';

function freshProgress() {
  return {
    steps: {
      import_rom: false,
      launch_game: false,
      verify_controls: false,
      online_session: false,
    },
    updatedAt: Date.now(),
  };
}

describe('onboardingStore', () => {
  beforeEach(() => {
    window.localStorage.removeItem(ONBOARDING_PROGRESS_STORAGE_KEY);
    useOnboardingStore.setState({
      progress: freshProgress(),
    });
  });

  test('marks steps complete and computes progress', () => {
    useOnboardingStore.getState().markStepComplete('import_rom');
    useOnboardingStore.getState().markStepComplete('launch_game');

    const progress = useOnboardingStore.getState().progress;
    expect(progress.steps.import_rom).toBe(true);
    expect(progress.steps.launch_game).toBe(true);
    expect(progress.steps.verify_controls).toBe(false);
    expect(onboardingProgressPercent(progress)).toBe(50);
    expect(onboardingChecklistVisible(progress)).toBe(true);
  });

  test('dismisses and reopens checklist', () => {
    useOnboardingStore.getState().dismissChecklist();
    let progress = useOnboardingStore.getState().progress;
    expect(typeof progress.dismissedAt).toBe('number');
    expect(onboardingChecklistVisible(progress)).toBe(false);

    useOnboardingStore.getState().reopenChecklist();
    progress = useOnboardingStore.getState().progress;
    expect(progress.dismissedAt).toBeUndefined();
    expect(onboardingChecklistVisible(progress)).toBe(true);
  });

  test('reset checklist clears all steps', () => {
    useOnboardingStore.getState().markStepComplete('import_rom');
    useOnboardingStore.getState().markStepComplete('launch_game');
    useOnboardingStore.getState().resetChecklist();

    const progress = useOnboardingStore.getState().progress;
    expect(progress.steps.import_rom).toBe(false);
    expect(progress.steps.launch_game).toBe(false);
    expect(progress.steps.verify_controls).toBe(false);
    expect(progress.steps.online_session).toBe(false);
    expect(progress.dismissedAt).toBeUndefined();
  });
});
