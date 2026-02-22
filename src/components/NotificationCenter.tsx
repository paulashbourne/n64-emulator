import { useEffect } from 'react';

import { useUiStore } from '../state/uiStore';

function classForTone(tone: 'info' | 'success' | 'warning' | 'error'): string {
  if (tone === 'success') {
    return 'notification-card notification-success';
  }
  if (tone === 'warning') {
    return 'notification-card notification-warning';
  }
  if (tone === 'error') {
    return 'notification-card notification-error';
  }
  return 'notification-card notification-info';
}

export function NotificationCenter() {
  const toasts = useUiStore((state) => state.toasts);
  const taskBanners = useUiStore((state) => state.taskBanners);
  const dismissToast = useUiStore((state) => state.dismissToast);
  const clearTaskBanner = useUiStore((state) => state.clearTaskBanner);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }

    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        dismissToast(toast.id);
      }, toast.autoDismissMs),
    );

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [dismissToast, toasts]);

  const hasVisibleFeedback = taskBanners.length > 0 || toasts.length > 0;
  if (!hasVisibleFeedback) {
    return null;
  }

  return (
    <div className="notification-center" aria-live="polite" aria-label="Application notifications">
      {taskBanners.map((banner) => (
        <section key={banner.id} className={classForTone(banner.tone)}>
          <div className="notification-copy">
            <p className="notification-title">{banner.message}</p>
            {banner.detail ? <p className="notification-detail">{banner.detail}</p> : null}
          </div>
          {banner.dismissible ? (
            <button type="button" onClick={() => clearTaskBanner(banner.id)} aria-label="Dismiss task banner">
              Dismiss
            </button>
          ) : null}
        </section>
      ))}

      {toasts.map((toast) => (
        <section key={toast.id} className={classForTone(toast.tone)}>
          <div className="notification-copy">
            {toast.title ? <p className="notification-title">{toast.title}</p> : null}
            <p className="notification-detail">{toast.message}</p>
          </div>
          <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
            Close
          </button>
        </section>
      ))}
    </div>
  );
}
