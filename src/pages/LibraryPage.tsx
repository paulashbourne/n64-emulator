import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { buildSessionPlayUrl, buildSessionRoute } from '../online/sessionLinks';
import { useAppStore } from '../state/appStore';

export function LibraryPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchParams] = useSearchParams();
  const [infoMessage, setInfoMessage] = useState<string>();

  const onlineCode = (searchParams.get('onlineCode') ?? '').trim().toUpperCase();
  const onlineClientId = (searchParams.get('onlineClientId') ?? '').trim();
  const onlineSessionContext =
    onlineCode && onlineClientId
      ? {
          onlineCode,
          onlineClientId,
        }
      : undefined;
  const sessionRoute = buildSessionRoute(onlineSessionContext);

  const roms = useAppStore((state) => state.roms);
  const searchTerm = useAppStore((state) => state.searchTerm);
  const sortMode = useAppStore((state) => state.sortMode);
  const favoritesOnly = useAppStore((state) => state.favoritesOnly);
  const loadingRoms = useAppStore((state) => state.loadingRoms);
  const romError = useAppStore((state) => state.romError);
  const browserSupportsDirectoryPicker = useAppStore((state) => state.browserSupportsDirectoryPicker);
  const hydrateLibraryPreferences = useAppStore((state) => state.hydrateLibraryPreferences);
  const refreshRoms = useAppStore((state) => state.refreshRoms);
  const setSearchTerm = useAppStore((state) => state.setSearchTerm);
  const setSortMode = useAppStore((state) => state.setSortMode);
  const setFavoritesOnly = useAppStore((state) => state.setFavoritesOnly);
  const indexDirectory = useAppStore((state) => state.indexDirectory);
  const reindexDirectories = useAppStore((state) => state.reindexDirectories);
  const importFiles = useAppStore((state) => state.importFiles);
  const removeRom = useAppStore((state) => state.removeRom);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  const libraryStats = useMemo(() => {
    const totalSizeBytes = roms.reduce((sum, rom) => sum + rom.size, 0);
    const playedCount = roms.filter((rom) => typeof rom.lastPlayed === 'number').length;
    return {
      totalRoms: roms.length,
      totalSizeMb: totalSizeBytes / (1024 * 1024),
      playedCount,
      importedCount: roms.filter((rom) => rom.source === 'import').length,
      indexedCount: roms.filter((rom) => rom.source === 'directory').length,
      favoriteCount: roms.filter((rom) => rom.favorite).length,
    };
  }, [roms]);

  const lastPlayedRom = useMemo(
    () =>
      roms
        .filter((rom) => typeof rom.lastPlayed === 'number')
        .sort((left, right) => (right.lastPlayed ?? 0) - (left.lastPlayed ?? 0))[0],
    [roms],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      await hydrateLibraryPreferences();
      if (!cancelled) {
        await refreshRoms();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hydrateLibraryPreferences, refreshRoms]);

  const onImportFiles = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setInfoMessage(undefined);
    const files = Array.from(event.target.files ?? []);
    const result = await importFiles(files);
    if (result.imported > 0 && result.skipped > 0) {
      setInfoMessage(
        `Imported ${result.imported} ROM${result.imported === 1 ? '' : 's'} and skipped ${result.skipped} invalid or duplicate file${result.skipped === 1 ? '' : 's'}.`,
      );
    } else if (result.imported > 0) {
      setInfoMessage(`Imported ${result.imported} ROM${result.imported === 1 ? '' : 's'}.`);
    }
    event.target.value = '';
  };

  const onReindexFolders = async (): Promise<void> => {
    setInfoMessage(undefined);
    const count = await reindexDirectories();
    setInfoMessage(
      count > 0
        ? `Re-indexed ${count} stored folder${count === 1 ? '' : 's'}.`
        : 'No previously granted folder handles were available to re-index.',
    );
  };

  const onRemoveRom = async (romId: string, title: string): Promise<void> => {
    setInfoMessage(undefined);
    const confirmed = window.confirm(`Remove "${title}" from the catalog?`);
    if (!confirmed) {
      return;
    }
    await removeRom(romId);
    setInfoMessage(`Removed "${title}" from the catalog.`);
  };

  const onCopyRomHash = async (title: string, hash: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
      setInfoMessage(`Copied ROM hash for "${title}".`);
    } catch {
      setInfoMessage(`Could not copy ROM hash for "${title}".`);
    }
  };

  return (
    <section className="library-page">
      <header className="panel">
        <h1>N64 ROM Library</h1>
        <p>Index a local folder (Chromium) or import ROM files directly.</p>
        <div className="library-stats" aria-label="Library statistics">
          <p>
            <strong>{libraryStats.totalRoms}</strong> ROMs
          </p>
          <p>
            <strong>{libraryStats.totalSizeMb.toFixed(1)} MB</strong> total
          </p>
          <p>
            <strong>{libraryStats.playedCount}</strong> played
          </p>
          <p>
            <strong>{libraryStats.indexedCount}</strong> indexed • <strong>{libraryStats.importedCount}</strong> imported
          </p>
          <p>
            <strong>{libraryStats.favoriteCount}</strong> favorites
          </p>
        </div>

        {!browserSupportsDirectoryPicker ? (
          <p className="warning-text">
            Folder access is unavailable in this browser. Import individual files instead.
          </p>
        ) : null}

        <div className="toolbar">
          {lastPlayedRom ? (
            <Link to={buildSessionPlayUrl(lastPlayedRom.id, onlineSessionContext)} className="resume-link">
              Resume Last Played: {lastPlayedRom.title}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setInfoMessage(undefined);
              void indexDirectory();
            }}
            disabled={!browserSupportsDirectoryPicker || loadingRoms}
          >
            Select ROM Folder
          </button>
          <button type="button" onClick={() => void onReindexFolders()} disabled={!browserSupportsDirectoryPicker || loadingRoms}>
            Re-index Stored Folders
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loadingRoms}>
            Import ROM Files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".z64,.n64,.v64"
            multiple
            onChange={(event) => void onImportFiles(event)}
            hidden
          />

          <label>
            Search
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => void setSearchTerm(event.target.value)}
              placeholder="Mario, Zelda, Star Fox..."
            />
          </label>

          <label>
            Sort
            <select
              value={sortMode}
              onChange={(event) => void setSortMode(event.target.value as 'title' | 'lastPlayed' | 'size' | 'favorite')}
            >
              <option value="title">Title</option>
              <option value="lastPlayed">Last Played</option>
              <option value="size">Size (Largest First)</option>
              <option value="favorite">Favorites First</option>
            </select>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={(event) => void setFavoritesOnly(event.target.checked)}
            />
            Favorites only
          </label>
        </div>

        {romError ? <p className="error-text">{romError}</p> : null}
        {infoMessage ? <p>{infoMessage}</p> : null}
      </header>

      {onlineSessionContext ? (
        <section className="panel session-banner">
          <h2>Online Host Session Active</h2>
          <p>
            Launching a ROM from this page will keep you connected to session <strong>{onlineCode}</strong>.
          </p>
          <div className="wizard-actions">
            {sessionRoute ? <Link to={sessionRoute}>Return to Session Room</Link> : null}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>Catalog ({roms.length})</h2>
        {loadingRoms ? <p>Loading ROMs…</p> : null}

        {roms.length === 0 && !loadingRoms ? (
          <p>No ROMs indexed yet. Select a folder or import files to begin.</p>
        ) : (
          <ul className="rom-list" aria-label="ROM catalog list">
            {roms.map((rom) => (
              <li key={rom.id} className={`rom-row ${rom.favorite ? 'favorite' : ''}`}>
                <div>
                  <h3>{rom.title}</h3>
                  <p>
                    {rom.extension} • {(rom.size / (1024 * 1024)).toFixed(2)} MB
                    {rom.relativePath ? ` • ${rom.relativePath}` : ''}
                  </p>
                  <small>
                    Source: {rom.source}
                    {rom.lastPlayed ? ` • Last played ${new Date(rom.lastPlayed).toLocaleString()}` : ''}
                  </small>
                </div>
                <div className="rom-actions">
                  <button
                    type="button"
                    className={`favorite-button ${rom.favorite ? 'active' : ''}`}
                    onClick={() => void toggleFavorite(rom.id)}
                    disabled={loadingRoms}
                  >
                    {rom.favorite ? 'Unfavorite' : 'Favorite'}
                  </button>
                  <button type="button" onClick={() => void onCopyRomHash(rom.title, rom.hash)} disabled={loadingRoms}>
                    Copy Hash
                  </button>
                  <Link to={buildSessionPlayUrl(rom.id, onlineSessionContext)}>Play</Link>
                  <button type="button" onClick={() => void onRemoveRom(rom.id, rom.title)} disabled={loadingRoms}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
