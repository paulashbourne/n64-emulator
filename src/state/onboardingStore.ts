import { create } from 'zustand';

import { UX_PREF_SYNC_V1_ENABLED } from '../config/uxFlags';
import { usePreferencesStore } from './preferencesStore';
import type { OnboardingProgress, OnboardingStep } from '../types/ux';

const ONBOARDING_PROGRESS_STORAGE_KEY = 'ux_onboarding_progress_v1';

const STEP_ORDER: OnboardingStep[] = ['import_rom', 'launch_game', 'verify_controls', 'online_session'];

const STEP_TITLES: Record<OnboardingStep, string> = {
  import_rom: 'Import a ROM',
  launch_game: 'Launch a game',
  verify_controls: 'Verify controls',
  online_session: 'Host or join online',
};

const STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  import_rom: 'Add at least one local ROM into your library.',
  launch_game: 'Boot one game to verify runtime is ready.',
  verify_controls: 'Open control settings and confirm your active profile.',
  online_session: 'Create or join a room with invite code flow.',
};

function initialProgress(): OnboardingProgress {
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

function readStoredProgress(): OnboardingProgress {
  if (typeof window === 'undefined') {
    return initialProgress();
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ONBOARDING_PROGRESS_STORAGE_KEY);
  } catch {
    return initialProgress();
  }

  if (!raw) {
    return initialProgress();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>;
    const next = initialProgress();
    next.steps.import_rom = parsed.steps?.import_rom === true;
    next.steps.launch_game = parsed.steps?.launch_game === true;
    next.steps.verify_controls = parsed.steps?.verify_controls === true;
    next.steps.online_session = parsed.steps?.online_session === true;
    next.dismissedAt = typeof parsed.dismissedAt === 'number' ? parsed.dismissedAt : undefined;
    next.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();
    return next;
  } catch {
    return initialProgress();
  }
}

function persistProgress(progress: OnboardingProgress): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(ONBOARDING_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Keep memory copy if storage is unavailable.
  }
}

function syncOnboardingProgressToPreferences(progress: OnboardingProgress): void {
  if (!UX_PREF_SYNC_V1_ENABLED) {
    return;
  }
  void usePreferencesStore.getState().syncFromOnboarding(progress).catch(() => {
    // Preference sync is best-effort.
  });
}

interface OnboardingStoreState {
  progress: OnboardingProgress;
  markStepComplete: (step: OnboardingStep) => void;
  resetChecklist: () => void;
  dismissChecklist: () => void;
  reopenChecklist: () => void;
}

export const useOnboardingStore = create<OnboardingStoreState>((set, get) => ({
  progress: readStoredProgress(),

  markStepComplete: (step) => {
    const current = get().progress;
    if (current.steps[step]) {
      return;
    }

    const next: OnboardingProgress = {
      ...current,
      steps: {
        ...current.steps,
        [step]: true,
      },
      updatedAt: Date.now(),
    };
    persistProgress(next);
    set({ progress: next });
    syncOnboardingProgressToPreferences(next);
  },

  resetChecklist: () => {
    const next = initialProgress();
    persistProgress(next);
    set({ progress: next });
    syncOnboardingProgressToPreferences(next);
  },

  dismissChecklist: () => {
    const current = get().progress;
    const next: OnboardingProgress = {
      ...current,
      dismissedAt: Date.now(),
      updatedAt: Date.now(),
    };
    persistProgress(next);
    set({ progress: next });
    syncOnboardingProgressToPreferences(next);
  },

  reopenChecklist: () => {
    const current = get().progress;
    const next: OnboardingProgress = {
      ...current,
      dismissedAt: undefined,
      updatedAt: Date.now(),
    };
    persistProgress(next);
    set({ progress: next });
    syncOnboardingProgressToPreferences(next);
  },
}));

export function applyOnboardingProgress(progress: OnboardingProgress): void {
  persistProgress(progress);
  useOnboardingStore.setState({ progress });
}

export function onboardingProgressPercent(progress: OnboardingProgress): number {
  const completedCount = STEP_ORDER.filter((step) => progress.steps[step]).length;
  return Math.round((completedCount / STEP_ORDER.length) * 100);
}

export function onboardingStepOrder(): OnboardingStep[] {
  return [...STEP_ORDER];
}

export function onboardingStepTitle(step: OnboardingStep): string {
  return STEP_TITLES[step];
}

export function onboardingStepDescription(step: OnboardingStep): string {
  return STEP_DESCRIPTIONS[step];
}

export function onboardingChecklistVisible(progress: OnboardingProgress): boolean {
  const allComplete = STEP_ORDER.every((step) => progress.steps[step]);
  if (allComplete) {
    return false;
  }
  return progress.dismissedAt === undefined;
}
