import { create } from 'zustand';

import type { TaskBanner, UiToast, UiToastAction, UiToastTone } from '../types/ux';

const DEFAULT_AUTO_DISMISS_MS = 4_200;
const MAX_TOASTS = 4;

function randomId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

interface UiStoreState {
  toasts: UiToast[];
  taskBanners: TaskBanner[];
  addToast: (input: {
    tone?: UiToastTone;
    title?: string;
    message: string;
    autoDismissMs?: number;
    dedupeKey?: string;
    action?: UiToastAction;
  }) => string;
  dismissToast: (toastId: string) => void;
  clearToasts: () => void;
  upsertTaskBanner: (input: {
    id: string;
    tone?: UiToastTone;
    message: string;
    detail?: string;
    dismissible?: boolean;
  }) => void;
  clearTaskBanner: (bannerId: string) => void;
  clearAllTaskBanners: () => void;
}

export const useUiStore = create<UiStoreState>((set) => ({
  toasts: [],
  taskBanners: [],

  addToast: ({
    tone = 'info',
    title,
    message,
    autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
    dedupeKey,
    action,
  }) => {
    const now = Date.now();
    const id = randomId('toast');
    set((state) => {
      if (dedupeKey) {
        const existing = state.toasts.find((toast) => toast.dedupeKey === dedupeKey);
        if (existing) {
          return {
            toasts: state.toasts.map((toast) =>
              toast.id === existing.id
                ? {
                    ...toast,
                    tone,
                    title,
                    message,
                    autoDismissMs,
                    action,
                    createdAt: now,
                  }
                : toast,
            ),
          };
        }
      }

      const nextToast: UiToast = {
        id,
        tone,
        title,
        message,
        action,
        dedupeKey,
        createdAt: now,
        autoDismissMs: Math.max(1_000, Math.min(15_000, Math.round(autoDismissMs))),
      };
      return {
        toasts: [nextToast, ...state.toasts].slice(0, MAX_TOASTS),
      };
    });
    return id;
  },

  dismissToast: (toastId) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== toastId),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },

  upsertTaskBanner: ({ id, tone = 'info', message, detail, dismissible = true }) => {
    set((state) => {
      const existing = state.taskBanners.find((banner) => banner.id === id);
      if (existing) {
        return {
          taskBanners: state.taskBanners.map((banner) =>
            banner.id === id
              ? {
                  ...banner,
                  tone,
                  message,
                  detail,
                  dismissible,
                }
              : banner,
          ),
        };
      }

      return {
        taskBanners: [
          ...state.taskBanners,
          {
            id,
            tone,
            message,
            detail,
            dismissible,
            startedAt: Date.now(),
          },
        ],
      };
    });
  },

  clearTaskBanner: (bannerId) => {
    set((state) => ({
      taskBanners: state.taskBanners.filter((banner) => banner.id !== bannerId),
    }));
  },

  clearAllTaskBanners: () => {
    set({ taskBanners: [] });
  },
}));
