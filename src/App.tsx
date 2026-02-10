import { NavLink, Route, Routes } from 'react-router-dom';

import { LibraryPage } from './pages/LibraryPage';
import { OnlinePage } from './pages/OnlinePage';
import { OnlineSessionPage } from './pages/OnlineSessionPage';
import { PlayPage } from './pages/PlayPage';
import { SettingsPage } from './pages/SettingsPage';

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Browser N64 Emulator</p>
          <h1>Local ROM Launcher</h1>
        </div>

        <nav>
          <NavLink to="/" end>
            Library
          </NavLink>
          <NavLink to="/online">Online</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/online" element={<OnlinePage />} />
          <Route path="/online/session/:code" element={<OnlineSessionPage />} />
          <Route path="/play/:romId" element={<PlayPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
