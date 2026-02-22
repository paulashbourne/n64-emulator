import { Suspense, lazy, useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { NotificationCenter } from './components/NotificationCenter';
import { UX_FEEDBACK_V2_ENABLED, UX_PREF_SYNC_V1_ENABLED } from './config/uxFlags';
import { useAuthStore } from './state/authStore';
import { usePreferencesStore } from './state/preferencesStore';

const LibraryPage = lazy(async () => {
  const module = await import('./pages/LibraryPage');
  return { default: module.LibraryPage };
});

const OnlinePage = lazy(async () => {
  const module = await import('./pages/OnlinePage');
  return { default: module.OnlinePage };
});

const OnlineSessionPage = lazy(async () => {
  const module = await import('./pages/OnlineSessionPage');
  return { default: module.OnlineSessionPage };
});

const PlayPage = lazy(async () => {
  const module = await import('./pages/PlayPage');
  return { default: module.PlayPage };
});

const SettingsPage = lazy(async () => {
  const module = await import('./pages/SettingsPage');
  return { default: module.SettingsPage };
});

const LoginPage = lazy(async () => {
  const module = await import('./pages/LoginPage');
  return { default: module.LoginPage };
});

const SignupPage = lazy(async () => {
  const module = await import('./pages/SignupPage');
  return { default: module.SignupPage };
});

function prefetchRouteModules(pathname: string): void {
  const schedule = (task: () => Promise<unknown>): void => {
    const run = () => {
      void task().catch(() => {
        // Prefetch failures are non-critical.
      });
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const idleCallback = window.requestIdleCallback as (callback: IdleRequestCallback) => number;
      idleCallback(() => run());
      return;
    }
    globalThis.setTimeout(run, 180);
  };

  if (pathname === '/') {
    schedule(() => import('./pages/PlayPage'));
    schedule(() => import('./pages/OnlinePage'));
    return;
  }
  if (pathname === '/online') {
    schedule(() => import('./pages/OnlineSessionPage'));
    schedule(() => import('./pages/PlayPage'));
    return;
  }
  if (pathname.startsWith('/online/session/')) {
    schedule(() => import('./pages/PlayPage'));
    return;
  }
  if (pathname.startsWith('/play/')) {
    schedule(() => import('./pages/OnlineSessionPage'));
  }
}

function App() {
  const location = useLocation();
  const isPlayRoute = location.pathname.startsWith('/play/');
  const isOnlineSessionRoute = location.pathname.startsWith('/online/session/');
  const authStatus = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const bootstrapAuth = useAuthStore((state) => state.bootstrapAuth);
  const logoutUser = useAuthStore((state) => state.logoutUser);
  const hydratePreferences = usePreferencesStore((state) => state.hydrateLocal);

  useEffect(() => {
    if (!UX_PREF_SYNC_V1_ENABLED) {
      return;
    }
    hydratePreferences();
  }, [hydratePreferences]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  useEffect(() => {
    prefetchRouteModules(location.pathname);
  }, [location.pathname]);

  return (
    <div
      className={`app-shell ${isPlayRoute ? 'app-shell-play' : ''} ${isOnlineSessionRoute ? 'app-shell-online-session' : ''}`}
    >
      <a href="#app-main-content" className="skip-link">
        Skip to main content
      </a>
      {!isPlayRoute ? (
        <header className="app-header">
          <Link to="/" className="app-header-brand app-brand-link" aria-label="WarpDeck 64 library home">
            <p className="eyebrow">Browser N64 Emulator</p>
            <h1>WarpDeck 64</h1>
          </Link>

          <nav className="app-header-nav" aria-label="Primary">
            <NavLink to="/" end>
              Library
            </NavLink>
            <NavLink to="/online">Online</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            {authStatus === 'guest' ? (
              <>
                <NavLink to="/login">Log In</NavLink>
                <NavLink to="/signup">Sign Up</NavLink>
              </>
            ) : null}
            {authStatus === 'authenticated' && user ? (
              <>
                <span className="status-pill">{user.username}</span>
                <button type="button" className="app-header-nav-button" onClick={() => void logoutUser()}>
                  Log Out
                </button>
              </>
            ) : null}
          </nav>
        </header>
      ) : null}

      {UX_FEEDBACK_V2_ENABLED ? <NotificationCenter /> : null}

      <main id="app-main-content" className={isPlayRoute ? 'app-main-play' : undefined}>
        <Suspense fallback={<section className="panel app-loading-panel">Loading…</section>}>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/online" element={<OnlinePage />} />
            <Route path="/online/session/:code" element={<OnlineSessionPage />} />
            <Route path="/play/:romId" element={<PlayPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export default App;
