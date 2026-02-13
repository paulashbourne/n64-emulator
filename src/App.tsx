import { Suspense, lazy } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

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

function App() {
  const location = useLocation();
  const isPlayRoute = location.pathname.startsWith('/play/');
  const isOnlineSessionRoute = location.pathname.startsWith('/online/session/');

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
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export default App;
