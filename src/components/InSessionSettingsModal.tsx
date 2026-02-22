import { lazy, Suspense, useEffect, useRef } from 'react';

import { useFocusTrap } from './useFocusTrap';

const SettingsPage = lazy(async () => {
  const module = await import('../pages/SettingsPage');
  return { default: module.SettingsPage };
});

interface InSessionSettingsModalProps {
  onClose: () => void;
  title?: string;
}

export function InSessionSettingsModal({ onClose, title = 'Settings' }: InSessionSettingsModalProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(panelRef, true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Escape') {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="in-session-settings-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={panelRef}
        className="panel in-session-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="in-session-settings-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="in-session-settings-body">
          <Suspense
            fallback={
              <section className="panel app-loading-panel">
                <p>Loading settings…</p>
              </section>
            }
          >
            <SettingsPage />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
