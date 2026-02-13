import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  deleteSaveSlotsForGame,
  listSaveSummariesByGame,
  resolveSaveGameIdentity,
} from '../emulator/saveSlots';
import { buildSessionPlayUrl, buildSessionRoute } from '../online/sessionLinks';
import { coverInventorySize, matchRomCoverArt, type RomCoverArtMatch } from '../roms/coverArtService';
import { useAppStore } from '../state/appStore';
import type { SaveGameSummary } from '../types/save';

interface CoverArtThumbProps {
  title: string;
  art: RomCoverArtMatch | null | undefined;
  className?: string;
}

type LibraryViewMode = 'list' | 'grid';
type LibrarySortOrderMode = 'default' | 'reversed';

interface LibraryUiPreferences {
  playedOnly: boolean;
  hasSavesOnly: boolean;
  coverMatchedOnly: boolean;
  sortOrderMode: LibrarySortOrderMode;
}

const LIBRARY_VIEW_MODE_STORAGE_KEY = 'library_view_mode_v1';
const LIBRARY_UI_PREFERENCES_STORAGE_KEY = 'library_ui_preferences_v2';
const LIBRARY_CONTROLS_EXPANDED_STORAGE_KEY = 'library_controls_expanded_v1';
const LIBRARY_SEARCH_DEBOUNCE_MS = 180;
const LIBRARY_COMPACT_MAX_WIDTH = 720;

function defaultLibraryControlsExpanded(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return !window.matchMedia(`(max-width: ${LIBRARY_COMPACT_MAX_WIDTH}px)`).matches;
}

function loadLibraryControlsExpanded(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    const stored = window.localStorage.getItem(LIBRARY_CONTROLS_EXPANDED_STORAGE_KEY);
    if (stored === 'true') {
      return true;
    }
    if (stored === 'false') {
      return false;
    }
  } catch {
    // Ignore persistence read failures and fall through to default behavior.
  }
  return defaultLibraryControlsExpanded();
}

function saveLibraryControlsExpanded(expanded: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LIBRARY_CONTROLS_EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // Ignore local storage write failures.
  }
}

function loadLibraryUiPreferences(): LibraryUiPreferences {
  if (typeof window === 'undefined') {
    return {
      playedOnly: false,
      hasSavesOnly: false,
      coverMatchedOnly: false,
      sortOrderMode: 'default',
    };
  }

  try {
    const raw = window.localStorage.getItem(LIBRARY_UI_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return {
        playedOnly: false,
        hasSavesOnly: false,
        coverMatchedOnly: false,
        sortOrderMode: 'default',
      };
    }
    const parsed = JSON.parse(raw) as Partial<LibraryUiPreferences>;
    return {
      playedOnly: parsed.playedOnly === true,
      hasSavesOnly: parsed.hasSavesOnly === true,
      coverMatchedOnly: parsed.coverMatchedOnly === true,
      sortOrderMode: parsed.sortOrderMode === 'reversed' ? 'reversed' : 'default',
    };
  } catch {
    return {
      playedOnly: false,
      hasSavesOnly: false,
      coverMatchedOnly: false,
      sortOrderMode: 'default',
    };
  }
}

function saveLibraryUiPreferences(preferences: LibraryUiPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LIBRARY_UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore local storage failures (private mode/quota), keeping the in-memory UX functional.
  }
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) {
    return 'never';
  }
  return new Date(timestamp).toLocaleString();
}

function coverMatchTypeLabel(matchType: RomCoverArtMatch['matchType']): string {
  switch (matchType) {
    case 'exact':
      return 'Exact';
    case 'compact':
      return 'Compact';
    case 'alias':
      return 'Alias';
    case 'fuzzy':
      return 'Fuzzy';
    default:
      return 'Matched';
  }
}

function coverMonogram(title: string): string {
  const words = title
    .split(/\s+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);

  if (words.length === 0) {
    return 'N64';
  }

  if (words.length === 1) {
    return words[0].slice(0, 3).toUpperCase();
  }

  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
}

function CoverArtThumb({ title, art, className }: CoverArtThumbProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const artUrl = art?.url;
  const showImage = Boolean(artUrl && failedUrl !== artUrl);

  return (
    <div className={`rom-cover ${className ?? ''}`} aria-hidden="true">
      {showImage ? (
        <img
          src={artUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(artUrl ?? null)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="rom-cover-fallback" aria-hidden="true">
          <span>{coverMonogram(title)}</span>
        </div>
      )}
    </div>
  );
}

export function LibraryPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialUiPreferences = useMemo(() => loadLibraryUiPreferences(), []);
  const [infoMessage, setInfoMessage] = useState<string>();
  const [playedOnly, setPlayedOnly] = useState(initialUiPreferences.playedOnly);
  const [hasSavesOnly, setHasSavesOnly] = useState(initialUiPreferences.hasSavesOnly);
  const [coverMatchedOnly, setCoverMatchedOnly] = useState(initialUiPreferences.coverMatchedOnly);
  const [sortOrderMode, setSortOrderMode] = useState<LibrarySortOrderMode>(initialUiPreferences.sortOrderMode);
  const [surpriseCursor, setSurpriseCursor] = useState(0);
  const [saveSummaryByGameKey, setSaveSummaryByGameKey] = useState<Map<string, SaveGameSummary>>(new Map());
  const [libraryControlsExpanded, setLibraryControlsExpanded] = useState(() => loadLibraryControlsExpanded());
  const [isCompactViewport, setIsCompactViewport] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(`(max-width: ${LIBRARY_COMPACT_MAX_WIDTH}px)`).matches;
  });
  const [coarsePointer, setCoarsePointer] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  });
  const [showSecondaryFilters, setShowSecondaryFilters] = useState(false);
  const [viewMode, setViewMode] = useState<LibraryViewMode>(() => {
    if (typeof window === 'undefined') {
      return 'list';
    }
    return window.localStorage.getItem(LIBRARY_VIEW_MODE_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
  });

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
  const [localSearchTerm, setLocalSearchTerm] = useState(searchTerm);

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
  const coverInventoryCount = useMemo(() => coverInventorySize(), []);
  const coverMatches = useMemo(() => {
    const byRomId = new Map<string, RomCoverArtMatch | null>();
    for (const rom of roms) {
      byRomId.set(rom.id, matchRomCoverArt(rom));
    }
    return byRomId;
  }, [roms]);
  const saveIdentityByRomId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveSaveGameIdentity>>();
    for (const rom of roms) {
      map.set(rom.id, resolveSaveGameIdentity(rom));
    }
    return map;
  }, [roms]);
  const lastPlayedCover = useMemo(() => {
    if (!lastPlayedRom) {
      return null;
    }
    return coverMatches.get(lastPlayedRom.id) ?? null;
  }, [coverMatches, lastPlayedRom]);
  const lastPlayedSaveSummary = useMemo(() => {
    if (!lastPlayedRom) {
      return undefined;
    }
    const identity = saveIdentityByRomId.get(lastPlayedRom.id);
    if (!identity) {
      return undefined;
    }
    return saveSummaryByGameKey.get(identity.gameKey);
  }, [lastPlayedRom, saveIdentityByRomId, saveSummaryByGameKey]);
  const variantCountByGameKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rom of roms) {
      const identity = saveIdentityByRomId.get(rom.id);
      if (!identity) {
        continue;
      }
      counts.set(identity.gameKey, (counts.get(identity.gameKey) ?? 0) + 1);
    }
    return counts;
  }, [roms, saveIdentityByRomId]);
  const catalogRoms = useMemo(
    () =>
      roms.filter((rom) => {
        if (playedOnly && !rom.lastPlayed) {
          return false;
        }
        if (coverMatchedOnly && !coverMatches.get(rom.id)) {
          return false;
        }
        if (hasSavesOnly) {
          const identity = saveIdentityByRomId.get(rom.id);
          if (!identity) {
            return false;
          }
          const summary = saveSummaryByGameKey.get(identity.gameKey);
          if (!summary?.primarySlotId) {
            return false;
          }
        }
        return true;
      }),
    [coverMatchedOnly, coverMatches, hasSavesOnly, playedOnly, roms, saveIdentityByRomId, saveSummaryByGameKey],
  );
  const visibleRoms = useMemo(
    () => (sortOrderMode === 'reversed' ? [...catalogRoms].reverse() : catalogRoms),
    [catalogRoms, sortOrderMode],
  );
  const hasActiveQuickFilters = playedOnly || hasSavesOnly || coverMatchedOnly;
  const hasAnyFilter = hasActiveQuickFilters || favoritesOnly || localSearchTerm.trim().length > 0;
  const controlsVisible = !isCompactViewport || libraryControlsExpanded;
  const filteredOutCount = roms.length - catalogRoms.length;
  const visibleStats = useMemo(() => {
    let totalSizeBytes = 0;
    let saveReadyCount = 0;
    let coverReadyCount = 0;

    for (const rom of visibleRoms) {
      totalSizeBytes += rom.size;
      const identity = saveIdentityByRomId.get(rom.id);
      if (identity) {
        const summary = saveSummaryByGameKey.get(identity.gameKey);
        if (summary?.primarySlotId) {
          saveReadyCount += 1;
        }
      }
      if (coverMatches.get(rom.id)) {
        coverReadyCount += 1;
      }
    }

    return {
      totalSizeMb: totalSizeBytes / (1024 * 1024),
      saveReadyCount,
      coverReadyCount,
    };
  }, [coverMatches, saveIdentityByRomId, saveSummaryByGameKey, visibleRoms]);
  const savedGamesCount = useMemo(() => {
    let count = 0;
    for (const summary of saveSummaryByGameKey.values()) {
      if (summary.primarySlotId) {
        count += 1;
      }
    }
    return count;
  }, [saveSummaryByGameKey]);
  const coveredGamesCount = useMemo(() => {
    let count = 0;
    for (const match of coverMatches.values()) {
      if (match) {
        count += 1;
      }
    }
    return count;
  }, [coverMatches]);
  const activeFilterChips = useMemo(
    () =>
      [
        localSearchTerm
          ? {
              key: 'search',
              label: `Search: ${localSearchTerm}`,
              onRemove: () => {
                setLocalSearchTerm('');
                void setSearchTerm('');
              },
            }
          : null,
        favoritesOnly
          ? {
              key: 'favorites',
              label: 'Favorites only',
              onRemove: () => setFavoritesOnly(false),
            }
          : null,
        playedOnly
          ? {
              key: 'played',
              label: 'Played only',
              onRemove: () => setPlayedOnly(false),
            }
          : null,
        hasSavesOnly
          ? {
              key: 'saves',
              label: 'Has saves',
              onRemove: () => setHasSavesOnly(false),
            }
          : null,
        coverMatchedOnly
          ? {
              key: 'cover',
              label: 'Has cover art',
              onRemove: () => setCoverMatchedOnly(false),
            }
          : null,
      ].filter((chip): chip is { key: string; label: string; onRemove: () => void } => Boolean(chip)),
    [coverMatchedOnly, favoritesOnly, hasSavesOnly, localSearchTerm, playedOnly, setFavoritesOnly, setSearchTerm],
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

  useEffect(() => {
    let cancelled = false;
    const loadSaveSummaries = async (): Promise<void> => {
      if (roms.length === 0) {
        setSaveSummaryByGameKey(new Map());
        return;
      }

      const uniqueKeys = Array.from(
        new Set(
          roms.map((rom) => {
            const identity = saveIdentityByRomId.get(rom.id);
            return identity?.gameKey;
          }),
        ),
      ).filter((key): key is string => Boolean(key));

      const summaries = await listSaveSummariesByGame(uniqueKeys);
      if (!cancelled) {
        setSaveSummaryByGameKey(summaries);
      }
    };

    void loadSaveSummaries();
    return () => {
      cancelled = true;
    };
  }, [roms, saveIdentityByRomId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(LIBRARY_VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (hasActiveQuickFilters) {
      setShowSecondaryFilters(true);
    }
  }, [hasActiveQuickFilters]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const compactQuery = window.matchMedia(`(max-width: ${LIBRARY_COMPACT_MAX_WIDTH}px)`);
    const pointerQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    const updateViewport = (): void => {
      setIsCompactViewport(compactQuery.matches);
    };
    const updatePointer = (): void => {
      setCoarsePointer(pointerQuery.matches);
    };

    updateViewport();
    updatePointer();
    if (typeof compactQuery.addEventListener === 'function') {
      compactQuery.addEventListener('change', updateViewport);
      pointerQuery.addEventListener('change', updatePointer);
      return () => {
        compactQuery.removeEventListener('change', updateViewport);
        pointerQuery.removeEventListener('change', updatePointer);
      };
    }

    compactQuery.addListener(updateViewport);
    pointerQuery.addListener(updatePointer);
    return () => {
      compactQuery.removeListener(updateViewport);
      pointerQuery.removeListener(updatePointer);
    };
  }, []);

  useEffect(() => {
    if (!isCompactViewport && !libraryControlsExpanded) {
      setLibraryControlsExpanded(true);
      return;
    }
    saveLibraryControlsExpanded(libraryControlsExpanded);
  }, [isCompactViewport, libraryControlsExpanded]);

  useEffect(() => {
    saveLibraryUiPreferences({
      playedOnly,
      hasSavesOnly,
      coverMatchedOnly,
      sortOrderMode,
    });
  }, [coverMatchedOnly, hasSavesOnly, playedOnly, sortOrderMode]);

  useEffect(() => {
    setLocalSearchTerm(searchTerm);
  }, [searchTerm]);

  useEffect(() => {
    if (localSearchTerm === searchTerm) {
      return;
    }
    const timer = window.setTimeout(() => {
      void setSearchTerm(localSearchTerm);
    }, LIBRARY_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [localSearchTerm, searchTerm, setSearchTerm]);

  useEffect(() => {
    if (!infoMessage) {
      return;
    }
    const timer = window.setTimeout(() => {
      setInfoMessage((current) => (current === infoMessage ? undefined : current));
    }, 4200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [infoMessage]);

  useEffect(() => {
    const isTextEntryTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) {
        return false;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return true;
      }
      return Boolean(element.closest('[contenteditable="true"]'));
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTextEntryTarget(event.target)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        event.preventDefault();
        if (localSearchTerm.length > 0) {
          setLocalSearchTerm('');
        } else {
          searchInputRef.current?.blur();
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTextEntryTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'g') {
        event.preventDefault();
        setViewMode((current) => (current === 'list' ? 'grid' : 'list'));
        return;
      }

      if (key === 'f') {
        event.preventDefault();
        void setFavoritesOnly(!favoritesOnly);
        return;
      }

      if (key === 'p') {
        event.preventDefault();
        setPlayedOnly((value) => !value);
        return;
      }

      if (key === 's') {
        event.preventDefault();
        setHasSavesOnly((value) => !value);
        return;
      }

      if (key === 'c') {
        event.preventDefault();
        setCoverMatchedOnly((value) => !value);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    favoritesOnly,
    localSearchTerm.length,
    setFavoritesOnly,
  ]);

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

  const buildPlayLinkWithSaveSlot = (romId: string, slotId?: string): string => {
    const base = buildSessionPlayUrl(romId, onlineSessionContext);
    if (!slotId) {
      return base;
    }
    const [path, existingQuery] = base.split('?');
    const params = new URLSearchParams(existingQuery ?? '');
    params.set('saveSlot', slotId);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  };

  const onDeleteGameSaves = async (romId: string, romTitle: string): Promise<void> => {
    const identity = saveIdentityByRomId.get(romId);
    if (!identity) {
      return;
    }

    const confirmed = window.confirm(`Delete all save slots for "${identity.displayTitle}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    const removed = await deleteSaveSlotsForGame(identity.gameKey);
    if (removed === 0) {
      setInfoMessage(`No save slots found for "${identity.displayTitle}".`);
    } else {
      setInfoMessage(`Deleted ${removed} save slot${removed === 1 ? '' : 's'} for "${romTitle}".`);
    }

    const uniqueKeys = Array.from(new Set(roms.map((entry) => saveIdentityByRomId.get(entry.id)?.gameKey))).filter(
      (key): key is string => Boolean(key),
    );
    setSaveSummaryByGameKey(await listSaveSummariesByGame(uniqueKeys));
  };

  const onPlayRandom = (): void => {
    if (visibleRoms.length === 0) {
      return;
    }
    const nextIndex = (surpriseCursor * 7 + 3) % visibleRoms.length;
    const nextRom = visibleRoms[nextIndex];
    setSurpriseCursor((current) => current + 1);
    setInfoMessage(`Launching surprise pick: "${nextRom.title}".`);
    navigate(buildSessionPlayUrl(nextRom.id, onlineSessionContext));
  };

  const clearAllFilters = (): void => {
    setPlayedOnly(false);
    setHasSavesOnly(false);
    setCoverMatchedOnly(false);
    void setFavoritesOnly(false);
    setLocalSearchTerm('');
    void setSearchTerm('');
  };

  return (
    <section className="library-page">
      <header className="panel library-hero-panel">
        <div className="library-hero-grid">
          <div className="library-hero-copy">
            <h1>N64 ROM Library</h1>
            <p>Index a local folder (Chromium) or import ROM files directly.</p>
            <p className="library-cover-caption">Auto-cover matching from {coverInventoryCount} cataloged N64 box arts.</p>
          </div>
          <div className="library-resume-pane">
            {lastPlayedRom ? (
              <Link to={buildSessionPlayUrl(lastPlayedRom.id, onlineSessionContext)} className="library-resume-card">
                <CoverArtThumb title={lastPlayedRom.title} art={lastPlayedCover} className="library-resume-cover" />
                <div>
                  <p className="library-resume-eyebrow">Resume Last Played</p>
                  <h2>{lastPlayedRom.title}</h2>
                  <p>
                    Played {lastPlayedRom.lastPlayed ? new Date(lastPlayedRom.lastPlayed).toLocaleString() : 'recently'}
                    {lastPlayedSaveSummary?.lastSavedAt
                      ? ` • Saved ${new Date(lastPlayedSaveSummary.lastSavedAt).toLocaleString()}`
                      : ' • Save never'}
                    {lastPlayedCover ? ` • Cover: ${lastPlayedCover.title}` : ''}
                  </p>
                </div>
              </Link>
            ) : (
              <div className="library-resume-empty">
                <p className="library-resume-eyebrow">Resume Last Played</p>
                <h2>Pick your first game</h2>
                <p>Once you play a ROM, we will pin it here with cover art and one-click resume.</p>
              </div>
            )}
          </div>
        </div>

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
          <p>
            <strong>{savedGamesCount}</strong> with saves
          </p>
          <p>
            <strong>{coveredGamesCount}</strong> with cover art
          </p>
        </div>

        {!browserSupportsDirectoryPicker ? (
          <p className="warning-text">
            Folder access is unavailable in this browser. Import individual files instead.
          </p>
        ) : null}

        {isCompactViewport ? (
          <div className="library-controls-toggle-row">
            <button type="button" onClick={() => setLibraryControlsExpanded((value) => !value)}>
              {libraryControlsExpanded ? 'Hide Controls' : 'Show Controls'}
            </button>
            <button type="button" onClick={clearAllFilters} disabled={!hasAnyFilter}>
              Clear Filters
            </button>
          </div>
        ) : null}

        {controlsVisible ? (
          <>
            <div className="toolbar library-toolbar-primary">
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
              <button type="button" onClick={clearAllFilters} disabled={!hasAnyFilter}>
                Clear Filters
              </button>
              <button
                type="button"
                className="library-secondary-toggle"
                onClick={() => setShowSecondaryFilters((value) => !value)}
                aria-expanded={showSecondaryFilters}
              >
                {showSecondaryFilters ? 'Hide More Filters' : 'More Filters'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".z64,.n64,.v64"
                multiple
                onChange={(event) => void onImportFiles(event)}
                hidden
              />
            </div>

            <div className="toolbar library-toolbar-discovery">
              <label>
                Search
                <div className="library-search-field">
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={localSearchTerm}
                    onChange={(event) => setLocalSearchTerm(event.target.value)}
                    placeholder="Mario, Zelda, Star Fox..."
                    aria-label="Search ROMs"
                  />
                  {localSearchTerm ? (
                    <button type="button" className="library-search-clear" onClick={() => setLocalSearchTerm('')}>
                      Clear
                    </button>
                  ) : null}
                </div>
                <small className="online-subtle">Tip: press / to focus search. Press Esc to clear.</small>
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
            {showSecondaryFilters ? (
              <div className="library-quick-filters" aria-label="Library quick filters">
                <div className="library-view-toggle" role="group" aria-label="Catalog view mode">
                  <button
                    type="button"
                    className={viewMode === 'list' ? 'online-input-active' : undefined}
                    onClick={() => setViewMode('list')}
                  >
                    List View
                  </button>
                  <button
                    type="button"
                    className={viewMode === 'grid' ? 'online-input-active' : undefined}
                    onClick={() => setViewMode('grid')}
                  >
                    Cover Grid
                  </button>
                </div>
                <button
                  type="button"
                  className={`library-sort-order-button ${sortOrderMode === 'reversed' ? 'online-input-active' : ''}`}
                  onClick={() => setSortOrderMode((current) => (current === 'default' ? 'reversed' : 'default'))}
                >
                  Order: {sortOrderMode === 'default' ? 'Default' : 'Reversed'}
                </button>
                <button
                  type="button"
                  className={playedOnly ? 'online-input-active' : undefined}
                  onClick={() => setPlayedOnly((value) => !value)}
                >
                  Played only
                </button>
                <button
                  type="button"
                  className={hasSavesOnly ? 'online-input-active' : undefined}
                  onClick={() => setHasSavesOnly((value) => !value)}
                >
                  Has saves
                </button>
                <button
                  type="button"
                  className={coverMatchedOnly ? 'online-input-active' : undefined}
                  onClick={() => setCoverMatchedOnly((value) => !value)}
                >
                  Has cover art
                </button>
                <button type="button" onClick={onPlayRandom} disabled={visibleRoms.length === 0}>
                  Play Random
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlayedOnly(false);
                    setHasSavesOnly(false);
                    setCoverMatchedOnly(false);
                  }}
                  disabled={!hasActiveQuickFilters}
                >
                  Reset Quick Filters
                </button>
              </div>
            ) : (
              <p className="online-subtle library-secondary-controls-note">
                Secondary filters are hidden to keep the library clean. Use “More Filters” when needed.
              </p>
            )}
          </>
        ) : (
          <p className="online-subtle library-controls-collapsed-note">
            Controls are collapsed for focus mode. Tap “Show Controls” to search, sort, and filter.
          </p>
        )}
        {hasActiveQuickFilters ? (
          <p className="online-subtle">
            Showing {catalogRoms.length} of {roms.length} ROMs. {filteredOutCount} filtered out.
          </p>
        ) : null}
        <div className="library-visible-summary-chips" aria-label="Visible catalog summary">
          <span className="status-pill">Visible {visibleRoms.length}</span>
          <span className="status-pill">{visibleStats.totalSizeMb.toFixed(1)} MB</span>
          <span className="status-pill">{visibleStats.saveReadyCount} save-ready</span>
          <span className="status-pill">{visibleStats.coverReadyCount} with covers</span>
          <span className="status-pill">{sortOrderMode === 'default' ? 'Default order' : 'Reversed order'}</span>
        </div>
        {showSecondaryFilters ? (
          <p className="library-shortcuts-hint">
            {coarsePointer ? (
              <>Keyboard shortcuts are available when a keyboard is connected.</>
            ) : (
              <>
                Shortcuts: <code>/</code> search • <code>G</code> view • <code>F</code> favorites • <code>P</code> played •{' '}
                <code>S</code> saves • <code>C</code> covers.
              </>
            )}
          </p>
        ) : null}
        {showSecondaryFilters && activeFilterChips.length > 0 ? (
          <div className="library-active-filters" aria-label="Active filters">
            {activeFilterChips.map((chip) => (
              <button key={chip.key} type="button" className="status-pill status-pill-dismissible" onClick={chip.onRemove}>
                {chip.label} <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        ) : null}

        {romError ? <p className="library-feedback library-feedback-error" role="alert">{romError}</p> : null}
        {infoMessage ? <p className="library-feedback library-feedback-info" role="status">{infoMessage}</p> : null}
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
        <h2>Catalog ({visibleRoms.length})</h2>
        {loadingRoms ? <p>Loading ROMs…</p> : null}

        {visibleRoms.length === 0 && !loadingRoms ? (
          <div className="library-empty-state">
            <p>
              {roms.length === 0
                ? 'No ROMs indexed yet. Select a folder or import files to begin.'
                : 'No ROMs match your current quick filters. Reset filters to see the full catalog.'}
            </p>
            {roms.length > 0 ? (
              <button type="button" onClick={clearAllFilters}>
                Clear All Filters
              </button>
            ) : null}
          </div>
        ) : (
          <ul className={`rom-list ${viewMode === 'grid' ? 'rom-list-grid' : ''}`} aria-label="ROM catalog list">
            {visibleRoms.map((rom) => {
              const coverMatch = coverMatches.get(rom.id) ?? null;
              const identity = saveIdentityByRomId.get(rom.id);
              const saveSummary = identity ? saveSummaryByGameKey.get(identity.gameKey) : undefined;
              const hasSave = Boolean(saveSummary?.primarySlotId);
              const hasPlayed = Boolean(rom.lastPlayed);
              const variantCount = identity ? variantCountByGameKey.get(identity.gameKey) ?? 1 : 1;
              const playTarget = hasSave
                ? buildPlayLinkWithSaveSlot(rom.id, saveSummary?.primarySlotId)
                : buildSessionPlayUrl(rom.id, onlineSessionContext);
              return (
                <li key={rom.id} className={`rom-row rom-card ${rom.favorite ? 'favorite' : ''} ${viewMode === 'grid' ? 'rom-card-grid' : ''}`}>
                  <div className={`rom-card-main ${viewMode === 'grid' ? 'rom-card-main-grid' : ''}`}>
                    <CoverArtThumb title={rom.title} art={coverMatch} className={`rom-card-cover ${viewMode === 'grid' ? 'rom-card-cover-grid' : ''}`} />
                    <div className="rom-card-copy">
                      <h3>{rom.title}</h3>
                      <p className="rom-meta-line">
                        {rom.extension} • {(rom.size / (1024 * 1024)).toFixed(2)} MB
                      </p>
                      <small className="rom-meta-line">
                        Source: {rom.source} • Last played {formatDateTime(rom.lastPlayed)}
                      </small>
                      <small className="rom-meta-line">
                        Save: {saveSummary?.lastSavedAt ? formatDateTime(saveSummary.lastSavedAt) : 'never'}
                        {saveSummary?.slotCount && saveSummary.slotCount > 1 ? ` • ${saveSummary.slotCount} slots` : ''}
                        {coverMatch?.title ? ` • Cover: ${coverMatch.title}` : ''}
                      </small>
                      {rom.relativePath ? (
                        <small className="rom-relative-path" title={rom.relativePath}>
                          Path: {rom.relativePath}
                        </small>
                      ) : null}
                      <div className="rom-status-pills">
                        <span className={hasSave ? 'status-pill status-good' : 'status-pill'}>
                          {hasSave ? 'Save Ready' : 'No Save'}
                        </span>
                        <span className={hasPlayed ? 'status-pill status-good' : 'status-pill'}>
                          {hasPlayed ? 'Played' : 'New'}
                        </span>
                        <span className={coverMatch ? 'status-pill status-good' : 'status-pill'}>
                          {coverMatch ? `Cover ${coverMatchTypeLabel(coverMatch.matchType)}` : 'No Cover Match'}
                        </span>
                        {variantCount > 1 ? <span className="status-pill">{variantCount} ROM variants</span> : null}
                      </div>
                    </div>
                  </div>
                  <div className="rom-actions rom-actions-primary">
                    <Link className="rom-action-primary" to={playTarget}>
                      {hasSave ? 'Resume Save' : hasPlayed ? 'Play Again' : 'Play'}
                    </Link>
                    {hasSave ? <Link className="rom-action-muted" to={buildSessionPlayUrl(rom.id, onlineSessionContext)}>Fresh Boot</Link> : null}
                  </div>
                  <div className="rom-actions rom-actions-secondary">
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
                    <button
                      type="button"
                      onClick={() => void onDeleteGameSaves(rom.id, rom.title)}
                      disabled={loadingRoms || !saveSummary?.primarySlotId}
                    >
                      Reset Save
                    </button>
                    <button type="button" onClick={() => void onRemoveRom(rom.id, rom.title)} disabled={loadingRoms}>
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
