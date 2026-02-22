import { Suspense, lazy, useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { useAuthStore } from './state/authStore';

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

function App() {
  const location = useLocation();
  const isPlayRoute = location.pathname.startsWith('/play/');
  const isOnlineSessionRoute = location.pathname.startsWith('/online/session/');
  const authStatus = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const bootstrapAuth = useAuthStore((state) => state.bootstrapAuth);
  const logoutUser = useAuthStore((state) => state.logoutUser);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  return (
    <div
      className={`app-shell ${isPlayRoute ? 'app-shell-play' : ''} ${isOnlineSessionRoute ? 'app-shell-online-session' : ''}`}
    >
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

      <main className={isPlayRoute ? 'app-main-play' : undefined}>
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
