export type UiToastTone = 'info' | 'success' | 'warning' | 'error';

export interface UiToastAction {
  label: string;
  actionId: string;
}

export interface UiToast {
  id: string;
  tone: UiToastTone;
  title?: string;
  message: string;
  createdAt: number;
  autoDismissMs: number;
  dedupeKey?: string;
  action?: UiToastAction;
}

export interface TaskBanner {
  id: string;
  tone: UiToastTone;
  message: string;
  detail?: string;
  startedAt: number;
  dismissible?: boolean;
}

export type OnboardingStep =
  | 'import_rom'
  | 'launch_game'
  | 'verify_controls'
  | 'online_session';

export interface OnboardingProgress {
  steps: Record<OnboardingStep, boolean>;
  dismissedAt?: number;
  updatedAt: number;
}

export interface UserUiPreferences {
  onboarding: OnboardingProgress;
  online: {
    guestFocusMode?: boolean;
    showVirtualController?: boolean;
    guestInputRelayMode?: 'auto' | 'responsive' | 'balanced' | 'conservative';
    hostControlsCollapsed?: boolean;
    hostChatCollapsed?: boolean;
  };
  play: {
    autoHideHudWhileRunning?: boolean;
    activeMenuTab?: 'gameplay' | 'saves' | 'controls' | 'online';
    showOnlineAdvancedTools?: boolean;
  };
  profile: {
    displayName?: string;
    avatarUrl?: string;
    country?: string;
  };
  updatedAt: number;
}
