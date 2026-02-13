import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { ControllerWizard } from '../components/ControllerWizard';
import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import {
  getAdvancedSaveSlotsEnabled,
  getPreferredBootMode,
  setAdvancedSaveSlotsEnabled,
  setPreferredBootMode,
} from '../storage/appSettings';
import { clearIndexedData } from '../storage/db';
import { useAppStore } from '../state/appStore';
import type { ControllerProfile } from '../types/input';

const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';
type WizardMode = 'create' | 'edit';
type ProfileScopeFilter = 'all' | 'global' | 'rom';
type SettingsSectionKey = 'profiles' | 'boot' | 'save' | 'danger';
type ProfileSortMode = 'updated' | 'name' | 'mapped';

interface SettingsSectionVisibilityState {
  profiles: boolean;
  boot: boolean;
  save: boolean;
  danger: boolean;
}

const PROFILE_IMPORT_FILE_ACCEPT = '.json,application/json';
const SETTINGS_SECTION_VISIBILITY_STORAGE_KEY = 'settings_section_visibility_v1';
const SETTINGS_COMPACT_MAX_WIDTH = 900;
const SETTINGS_SECTION_DOM_ID: Record<SettingsSectionKey, string> = {
  profiles: 'settings-profiles',
  boot: 'settings-boot-mode',
  save: 'settings-save-experience',
  danger: 'settings-danger-zone',
};

function defaultSectionVisibilityState(): SettingsSectionVisibilityState {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return {
      profiles: true,
      boot: true,
      save: true,
      danger: true,
    };
  }
  const compact = window.matchMedia(`(max-width: ${SETTINGS_COMPACT_MAX_WIDTH}px)`).matches;
  if (!compact) {
    return {
      profiles: true,
      boot: true,
      save: true,
      danger: true,
    };
  }
  return {
    profiles: true,
    boot: false,
    save: false,
    danger: false,
  };
}

function loadSectionVisibilityState(): SettingsSectionVisibilityState {
  if (typeof window === 'undefined') {
    return defaultSectionVisibilityState();
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_SECTION_VISIBILITY_STORAGE_KEY);
    if (!raw) {
      return defaultSectionVisibilityState();
    }
    const parsed = JSON.parse(raw) as Partial<SettingsSectionVisibilityState>;
    return {
      profiles: parsed.profiles !== false,
      boot: parsed.boot !== false,
      save: parsed.save !== false,
      danger: parsed.danger !== false,
    };
  } catch {
    return defaultSectionVisibilityState();
  }
}

function saveSectionVisibilityState(state: SettingsSectionVisibilityState): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(SETTINGS_SECTION_VISIBILITY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore persistence issues to keep settings functional in constrained contexts.
  }
}

function clampDeadzone(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.2;
  }
  return Math.min(0.95, Math.max(0, value));
}

function normalizedProfileName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') {
    return fallback;
  }
  const normalized = name.replace(/\s+/g, ' ').trim().slice(0, 48);
  return normalized.length > 0 ? normalized : fallback;
}

function makeUniqueProfileName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name.toLowerCase())) {
    return name;
  }

  let suffix = 2;
  let candidate = `${name} (${suffix})`;
  while (existingNames.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${name} (${suffix})`;
  }
  return candidate;
}

function mappedControlCount(profile: ControllerProfile): number {
  return Object.keys(profile.bindings ?? {}).length;
}

function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatBootModeLabel(mode: EmulatorBootMode): string {
  if (mode === 'local') {
    return 'Local only';
  }
  if (mode === 'cdn') {
    return 'CDN only';
  }
  return 'Auto fallback';
}

function formatSortModeLabel(mode: ProfileSortMode): string {
  if (mode === 'name') {
    return 'Name';
  }
  if (mode === 'mapped') {
    return 'Mapped controls';
  }
  return 'Recently updated';
}

function normalizeImportedProfile(
  input: unknown,
  existingIds: Set<string>,
  existingNames: Set<string>,
): ControllerProfile | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<ControllerProfile>;
  const rawBindings = candidate.bindings;
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) {
    return null;
  }

  const baseName = normalizedProfileName(candidate.name, 'Imported Profile');
  const uniqueName = makeUniqueProfileName(baseName, existingNames);
  existingNames.add(uniqueName.toLowerCase());

  const rawId =
    typeof candidate.profileId === 'string' && candidate.profileId.trim().length > 0
      ? candidate.profileId.trim()
      : `profile:imported:${crypto.randomUUID()}`;
  let profileId = rawId;
  while (existingIds.has(profileId)) {
    profileId = `profile:imported:${crypto.randomUUID()}`;
  }
  existingIds.add(profileId);

  return {
    profileId,
    name: uniqueName,
    deviceId:
      typeof candidate.deviceId === 'string' && candidate.deviceId.trim().length > 0
        ? candidate.deviceId.trim()
        : 'keyboard-generic',
    romHash:
      typeof candidate.romHash === 'string' && candidate.romHash.trim().length > 0
        ? candidate.romHash.trim()
        : undefined,
    deadzone: clampDeadzone(typeof candidate.deadzone === 'number' ? candidate.deadzone : 0.2),
    bindings: rawBindings,
    updatedAt: Date.now(),
  };
}

function extractImportedProfiles(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  if (!input || typeof input !== 'object') {
    return [];
  }

  const parsed = input as {
    profile?: unknown;
    profiles?: unknown;
    profileId?: unknown;
  };

  if (Array.isArray(parsed.profiles)) {
    return parsed.profiles;
  }
  if (parsed.profile && typeof parsed.profile === 'object') {
    return [parsed.profile];
  }
  if (typeof parsed.profileId === 'string') {
    return [parsed];
  }
  return [];
}

export function SettingsPage() {
  const initialSectionVisibility = useMemo(() => loadSectionVisibilityState(), []);
  const profiles = useAppStore((state) => state.profiles);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const loadProfiles = useAppStore((state) => state.loadProfiles);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const removeProfile = useAppStore((state) => state.removeProfile);
  const setActiveProfile = useAppStore((state) => state.setActiveProfile);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const [working, setWorking] = useState(false);
  const [savingBootMode, setSavingBootMode] = useState(false);
  const [savingSaveMode, setSavingSaveMode] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [advancedSaveSlotsEnabled, setAdvancedSaveSlotsMode] = useState(false);
  const [message, setMessage] = useState<string>();
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info');
  const [searchTerm, setSearchTerm] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ProfileScopeFilter>('all');
  const [profileSortMode, setProfileSortMode] = useState<ProfileSortMode>('updated');
  const [profileSortAscending, setProfileSortAscending] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [importingProfiles, setImportingProfiles] = useState(false);
  const [showAdvancedProfileTools, setShowAdvancedProfileTools] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearConfirmValue, setClearConfirmValue] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>('create');
  const [wizardTemplateProfile, setWizardTemplateProfile] = useState<ControllerProfile>();
  const [sectionVisibility, setSectionVisibility] = useState<SettingsSectionVisibilityState>(initialSectionVisibility);
  const [isCompactViewport, setIsCompactViewport] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(`(max-width: ${SETTINGS_COMPACT_MAX_WIDTH}px)`).matches;
  });
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    const loadBootMode = async (): Promise<void> => {
      const [mode, saveSlotsEnabled] = await Promise.all([
        getPreferredBootMode(),
        getAdvancedSaveSlotsEnabled(),
      ]);
      if (!cancelled) {
        setBootMode(mode);
        setAdvancedSaveSlotsMode(saveSlotsEnabled);
      }
    };
    void loadBootMode();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const compactQuery = window.matchMedia(`(max-width: ${SETTINGS_COMPACT_MAX_WIDTH}px)`);
    const updateCompactMode = (): void => {
      setIsCompactViewport(compactQuery.matches);
    };

    updateCompactMode();
    if (typeof compactQuery.addEventListener === 'function') {
      compactQuery.addEventListener('change', updateCompactMode);
      return () => {
        compactQuery.removeEventListener('change', updateCompactMode);
      };
    }

    compactQuery.addListener(updateCompactMode);
    return () => {
      compactQuery.removeListener(updateCompactMode);
    };
  }, []);

  useEffect(() => {
    if (!isCompactViewport) {
      const expandedState: SettingsSectionVisibilityState = {
        profiles: true,
        boot: true,
        save: true,
        danger: true,
      };
      setSectionVisibility((current) => {
        if (
          current.profiles === expandedState.profiles &&
          current.boot === expandedState.boot &&
          current.save === expandedState.save &&
          current.danger === expandedState.danger
        ) {
          return current;
        }
        return expandedState;
      });
      saveSectionVisibilityState(expandedState);
      return;
    }
    saveSectionVisibilityState(sectionVisibility);
  }, [isCompactViewport, sectionVisibility]);

  useEffect(() => {
    if (!message || messageTone === 'error') {
      return;
    }
    const timer = window.setTimeout(() => {
      setMessage((current) => (current === message ? undefined : current));
    }, 4200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [message, messageTone]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTypingTarget =
        !!target &&
        (target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT');

      if (event.key === '/' && !isTypingTarget) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (event.key === 'Escape') {
        if (message) {
          event.preventDefault();
          setMessage(undefined);
          return;
        }

        if (searchTerm.trim().length > 0 || scopeFilter !== 'all' || activeOnly) {
          setSearchTerm('');
          setScopeFilter('all');
          setActiveOnly(false);
          searchInputRef.current?.blur();
        }
        return;
      }

      if (event.key >= '1' && event.key <= '4' && !isTypingTarget) {
        event.preventDefault();
        const sectionOrder: SettingsSectionKey[] = ['profiles', 'boot', 'save', 'danger'];
        const section = sectionOrder[Number(event.key) - 1];
        if (!section) {
          return;
        }
        if (event.shiftKey) {
          setSectionVisibility((current) => ({
            ...current,
            [section]: !current[section],
          }));
          return;
        }
        if (isCompactViewport) {
          setSectionVisibility({
            profiles: section === 'profiles',
            boot: section === 'boot',
            save: section === 'save',
            danger: section === 'danger',
          });
        } else {
          setSectionVisibility((current) => ({
            ...current,
            [section]: true,
          }));
        }
        window.requestAnimationFrame(() => {
          const sectionId = SETTINGS_SECTION_DOM_ID[section];
          document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeOnly, isCompactViewport, message, scopeFilter, searchTerm]);

  const activeProfile = profiles.find((profile) => profile.profileId === activeProfileId);
  const filteredProfiles = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return profiles.filter((profile) => {
      if (scopeFilter === 'global' && profile.romHash) {
        return false;
      }
      if (scopeFilter === 'rom' && !profile.romHash) {
        return false;
      }
      if (activeOnly && profile.profileId !== activeProfileId) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const haystack = `${profile.name} ${profile.deviceId} ${profile.romHash ?? ''}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [activeOnly, activeProfileId, profiles, scopeFilter, searchTerm]);

  const sortedProfiles = useMemo(() => {
    const withMappedCount = filteredProfiles.map((profile) => ({
      profile,
      mappedCount: mappedControlCount(profile),
    }));
    withMappedCount.sort((left, right) => {
      if (profileSortMode === 'name') {
        return left.profile.name.localeCompare(right.profile.name, undefined, { sensitivity: 'base' });
      }
      if (profileSortMode === 'mapped') {
        return left.mappedCount - right.mappedCount;
      }
      return left.profile.updatedAt - right.profile.updatedAt;
    });

    if (!profileSortAscending) {
      withMappedCount.reverse();
    }

    return withMappedCount.map((entry) => entry.profile);
  }, [filteredProfiles, profileSortAscending, profileSortMode]);

  const globalProfileCount = useMemo(
    () => profiles.filter((profile) => !profile.romHash).length,
    [profiles],
  );
  const romSpecificProfileCount = profiles.length - globalProfileCount;
  const averageMappedControls = useMemo(() => {
    if (profiles.length === 0) {
      return 0;
    }
    const total = profiles.reduce((sum, profile) => sum + mappedControlCount(profile), 0);
    return Math.round(total / profiles.length);
  }, [profiles]);
  const hasProfileFilters = searchTerm.trim().length > 0 || scopeFilter !== 'all' || activeOnly;

  const setFeedback = (value: string | undefined, tone: 'info' | 'success' | 'error' = 'info'): void => {
    setMessage(value);
    setMessageTone(tone);
  };

  const clearProfileFilters = (): void => {
    setSearchTerm('');
    setScopeFilter('all');
    setActiveOnly(false);
  };

  const applySectionVisibilityPreset = (nextState: SettingsSectionVisibilityState): void => {
    setSectionVisibility(nextState);
  };

  const focusSingleSection = (section: SettingsSectionKey): void => {
    applySectionVisibilityPreset({
      profiles: section === 'profiles',
      boot: section === 'boot',
      save: section === 'save',
      danger: section === 'danger',
    });
  };

  const revealSection = (section: SettingsSectionKey): void => {
    if (isCompactViewport) {
      focusSingleSection(section);
    } else {
      setSectionVisibility((current) => ({
        ...current,
        [section]: true,
      }));
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const sectionId = SETTINGS_SECTION_DOM_ID[section];
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };

  const toggleSectionVisibility = (section: SettingsSectionKey): void => {
    setSectionVisibility((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

  const onDeleteProfile = async (profileId: string): Promise<void> => {
    const profile = profiles.find((entry) => entry.profileId === profileId);
    if (!profile) {
      return;
    }

    const confirmed = window.confirm(`Delete controller profile "${profile.name}"?`);
    if (!confirmed) {
      return;
    }

    setWorking(true);
    setFeedback(undefined);
    try {
      await removeProfile(profileId);
      setFeedback('Profile removed.', 'success');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to remove profile.', 'error');
    } finally {
      setWorking(false);
    }
  };

  const onClearData = async (): Promise<void> => {
    setWorking(true);
    setFeedback(undefined);
    try {
      await clearIndexedData();
      await refreshRoms();
      await loadProfiles();
      setClearConfirmOpen(false);
      setClearConfirmValue('');
      setFeedback('Indexed ROMs, saves, and profiles were cleared.', 'success');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to clear data.', 'error');
    } finally {
      setWorking(false);
    }
  };

  const onBootModeChange = async (mode: EmulatorBootMode): Promise<void> => {
    setSavingBootMode(true);
    setFeedback(undefined);
    try {
      await setPreferredBootMode(mode);
      setBootMode(mode);
      setFeedback(
        `Saved default boot mode: ${mode === 'auto' ? 'Auto fallback' : mode === 'local' ? 'Local cores only' : 'CDN cores only'}.`,
        'success',
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to save boot mode.', 'error');
    } finally {
      setSavingBootMode(false);
    }
  };

  const onAdvancedSaveSlotsToggle = async (enabled: boolean): Promise<void> => {
    setSavingSaveMode(true);
    setFeedback(undefined);
    try {
      await setAdvancedSaveSlotsEnabled(enabled);
      setAdvancedSaveSlotsMode(enabled);
      setFeedback(
        enabled
          ? 'Advanced save slots are enabled. Play and Library will show expert save controls.'
          : 'Advanced save slots are disabled. Console-style single autosave remains active.',
        'success',
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to save advanced save mode.', 'error');
    } finally {
      setSavingSaveMode(false);
    }
  };

  const openCreateWizard = (): void => {
    setWizardMode('create');
    setWizardTemplateProfile(undefined);
    setWizardOpen(true);
  };

  const openEditWizard = (profileId?: string): void => {
    if (!profileId) {
      openCreateWizard();
      return;
    }

    setActiveProfile(profileId);
    setWizardMode('edit');
    setWizardTemplateProfile(undefined);
    setWizardOpen(true);
  };

  const openCloneWizard = (profileId?: string): void => {
    const sourceProfile = profiles.find((profile) => profile.profileId === profileId);
    if (!sourceProfile) {
      openCreateWizard();
      return;
    }

    setActiveProfile(sourceProfile.profileId);
    setWizardMode('create');
    setWizardTemplateProfile(sourceProfile);
    setWizardOpen(true);
  };

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
    setWizardMode('create');
    setWizardTemplateProfile(undefined);
    setFeedback(`Saved controller profile "${profile.name}".`, 'success');
  };

  const onSetKeyboardDefaultActive = (): void => {
    setActiveProfile(DEFAULT_KEYBOARD_PROFILE_ID);
    setFeedback('Activated Keyboard Default profile.', 'success');
  };

  const onExportActiveProfile = (): void => {
    if (!activeProfile) {
      return;
    }

    const payload = {
      version: 1,
      exportedAt: Date.now(),
      profile: activeProfile,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const normalizedName = activeProfile.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    anchor.href = url;
    anchor.download = `${normalizedName || 'controller-profile'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback(`Exported profile "${activeProfile.name}".`, 'success');
  };

  const onExportAllProfiles = (): void => {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      profiles,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'controller-profiles-all.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback(`Exported ${profiles.length} profile${profiles.length === 1 ? '' : 's'}.`, 'success');
  };

  const onImportProfilesClick = (): void => {
    importInputRef.current?.click();
  };

  const onImportProfilesChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setImportingProfiles(true);
    setFeedback(undefined);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const importedCandidates = extractImportedProfiles(parsed);
      if (importedCandidates.length === 0) {
        throw new Error('No controller profile entries were found in this file.');
      }

      const existingIds = new Set(profiles.map((profile) => profile.profileId));
      const existingNames = new Set(profiles.map((profile) => profile.name.toLowerCase()));
      let importedCount = 0;
      let lastImportedProfileId: string | undefined;
      for (const entry of importedCandidates) {
        const normalized = normalizeImportedProfile(entry, existingIds, existingNames);
        if (!normalized) {
          continue;
        }
        await saveProfile(normalized);
        importedCount += 1;
        lastImportedProfileId = normalized.profileId;
      }

      if (importedCount === 0) {
        throw new Error('No valid controller profiles were imported from this file.');
      }
      if (lastImportedProfileId) {
        setActiveProfile(lastImportedProfileId);
      }
      setFeedback(`Imported ${importedCount} profile${importedCount === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to import controller profiles.', 'error');
    } finally {
      setImportingProfiles(false);
      event.target.value = '';
    }
  };

  return (
    <section className="settings-page">
      <header className="panel settings-hero-panel">
        <h1>Settings</h1>
        <p>Manage controller profiles and local emulator data.</p>
        <div className="settings-summary-row">
          <span className="status-pill">Profiles: {profiles.length}</span>
          <span className={`status-pill ${advancedSaveSlotsEnabled ? 'status-warn' : 'status-good'}`}>
            Save mode: {advancedSaveSlotsEnabled ? 'Advanced' : 'Console-like'}
          </span>
          <span className="status-pill">Boot: {bootMode}</span>
        </div>
        <p className="settings-summary-caption">
          Global: {globalProfileCount} • ROM-specific: {romSpecificProfileCount} • Avg mapped controls: {averageMappedControls}
        </p>
        <nav className="settings-jump-links" aria-label="Settings sections">
          <button type="button" onClick={() => revealSection('profiles')}>
            Controller Profiles <span className="settings-jump-shortcut">1</span>
          </button>
          <button type="button" onClick={() => revealSection('boot')}>
            Boot Mode <span className="settings-jump-shortcut">2</span>
          </button>
          <button type="button" onClick={() => revealSection('save')}>
            Save Experience <span className="settings-jump-shortcut">3</span>
          </button>
          <button type="button" onClick={() => revealSection('danger')}>
            Danger Zone <span className="settings-jump-shortcut">4</span>
          </button>
        </nav>
        <p className="settings-shortcuts-hint settings-header-shortcuts-hint">
          Shortcuts: <code>1-4</code> jump sections, <code>Shift+1-4</code> toggle section visibility, <code>/</code>{' '}
          focus profile search.
        </p>
        {message ? (
          <div
            className={`settings-feedback ${
              messageTone === 'error'
                ? 'settings-feedback-error'
                : messageTone === 'success'
                  ? 'settings-feedback-success'
                  : 'settings-feedback-info'
            }`}
            role={messageTone === 'error' ? 'alert' : 'status'}
          >
            <p>{message}</p>
            <button type="button" onClick={() => setMessage(undefined)}>
              Dismiss
            </button>
          </div>
        ) : null}
      </header>

      <section className="panel" id="settings-profiles">
        <div className="settings-section-head">
          <div>
            <h2>Controller Profiles</h2>
            <p className="settings-section-meta">
              {sortedProfiles.length} visible • {profiles.length} total • Sorted by {formatSortModeLabel(profileSortMode)}
            </p>
          </div>
          {isCompactViewport ? (
            <button type="button" className="settings-section-toggle" onClick={() => toggleSectionVisibility('profiles')}>
              {sectionVisibility.profiles ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </div>
        {sectionVisibility.profiles ? (
          <>
            <div className="wizard-actions settings-primary-actions">
              <button type="button" onClick={openCreateWizard} disabled={working}>
                Create Profile
              </button>
              <button type="button" onClick={() => openEditWizard(activeProfileId)} disabled={working || !activeProfile}>
                Edit Active
              </button>
              <button type="button" onClick={() => openCloneWizard(activeProfileId)} disabled={working || !activeProfile}>
                Clone Active
              </button>
              <button type="button" onClick={onSetKeyboardDefaultActive} disabled={working}>
                Use Keyboard Default
              </button>
              <button type="button" onClick={() => setShowAdvancedProfileTools((value) => !value)} disabled={working}>
                {showAdvancedProfileTools ? 'Hide Advanced Tools' : 'Show Advanced Tools'}
              </button>
            </div>
            {showAdvancedProfileTools ? (
              <div className="settings-advanced-tools">
                <p>Import and export profile JSON bundles for backup or transfer.</p>
                <div className="wizard-actions">
                  <button type="button" onClick={onExportActiveProfile} disabled={working || !activeProfile}>
                    Export Active
                  </button>
                  <button type="button" onClick={onExportAllProfiles} disabled={working || profiles.length === 0}>
                    Export All
                  </button>
                  <button type="button" onClick={onImportProfilesClick} disabled={working || importingProfiles}>
                    {importingProfiles ? 'Importing…' : 'Import Profiles'}
                  </button>
                </div>
              </div>
            ) : null}
            <input
              ref={importInputRef}
              type="file"
              accept={PROFILE_IMPORT_FILE_ACCEPT}
              hidden
              onChange={(event) => void onImportProfilesChange(event)}
            />

            <div className="settings-profile-tools">
              <label>
                Search
                <div className="settings-search-field">
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Name, device id, ROM hash"
                  />
                  {searchTerm ? (
                    <button type="button" onClick={() => setSearchTerm('')}>
                      Clear
                    </button>
                  ) : null}
                </div>
              </label>
              <label>
                Scope
                <select
                  value={scopeFilter}
                  onChange={(event) => setScopeFilter(event.target.value as ProfileScopeFilter)}
                >
                  <option value="all">All profiles</option>
                  <option value="global">Global only</option>
                  <option value="rom">ROM-specific only</option>
                </select>
              </label>
              <label>
                Sort
                <div className="settings-sort-controls">
                  <select
                    value={profileSortMode}
                    onChange={(event) => setProfileSortMode(event.target.value as ProfileSortMode)}
                  >
                    <option value="updated">Recently updated</option>
                    <option value="name">Name</option>
                    <option value="mapped">Mapped controls</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setProfileSortAscending((value) => !value)}
                    aria-label={profileSortAscending ? 'Sort descending' : 'Sort ascending'}
                  >
                    {profileSortAscending ? 'Ascending' : 'Descending'}
                  </button>
                </div>
              </label>
            </div>
            <label className="checkbox-label settings-active-only-toggle">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(event) => setActiveOnly(event.target.checked)}
              />
              Active only
            </label>
            <p className="settings-shortcuts-hint">
              Shortcuts: <code>/</code> focus profile search, <code>Esc</code> clear filters and status messages.
            </p>
            {(searchTerm.trim() || scopeFilter !== 'all' || activeOnly) ? (
              <div className="settings-filter-chip-row">
                {searchTerm.trim() ? (
                  <button type="button" className="status-pill status-pill-dismissible" onClick={() => setSearchTerm('')}>
                    Search: {searchTerm.trim()} <span aria-hidden="true">×</span>
                  </button>
                ) : null}
                {scopeFilter !== 'all' ? (
                  <button type="button" className="status-pill status-pill-dismissible" onClick={() => setScopeFilter('all')}>
                    Scope: {scopeFilter === 'global' ? 'Global only' : 'ROM-specific only'} <span aria-hidden="true">×</span>
                  </button>
                ) : null}
                {activeOnly ? (
                  <button type="button" className="status-pill status-pill-dismissible" onClick={() => setActiveOnly(false)}>
                    Active only <span aria-hidden="true">×</span>
                  </button>
                ) : null}
                <button type="button" onClick={clearProfileFilters} disabled={!hasProfileFilters}>
                  Reset Filters
                </button>
              </div>
            ) : null}
            {profiles.length > 0 ? (
              <label>
                Active profile
                <select
                  value={activeProfileId ?? ''}
                  onChange={(event) => setActiveProfile(event.target.value || undefined)}
                  disabled={working}
                >
                  <option value="">None</option>
                  {profiles.map((profile) => (
                    <option key={profile.profileId} value={profile.profileId}>
                      {profile.name}
                      {profile.romHash ? ' (ROM-specific)' : ' (Global)'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {profiles.length === 0 ? <p>No controller profiles stored.</p> : null}
            {profiles.length > 0 && filteredProfiles.length === 0 ? (
              <p>No controller profiles match your current search/filter.</p>
            ) : null}
            {profiles.length > 0 ? (
              <p className="settings-filter-summary">
                Showing {sortedProfiles.length} of {profiles.length} profile{profiles.length === 1 ? '' : 's'} •{' '}
                {profileSortAscending ? 'ascending' : 'descending'} by {formatSortModeLabel(profileSortMode).toLowerCase()}.
              </p>
            ) : null}
            <ul className="profile-list">
              {sortedProfiles.map((profile) => (
                <li key={profile.profileId}>
                  <div className="profile-row-copy">
                    <div className="profile-row-title">
                      <strong>{profile.name}</strong>
                      {activeProfileId === profile.profileId ? <span className="status-pill status-good">Active</span> : null}
                    </div>
                    <p>
                      Device: {profile.deviceId} • Deadzone: {profile.deadzone.toFixed(2)}
                    </p>
                    <div className="profile-row-meta">
                      <span className="status-pill">
                        {profile.romHash ? `ROM: ${profile.romHash.slice(0, 12)}…` : 'Global'}
                      </span>
                      <span className="status-pill">{mappedControlCount(profile)} mapped</span>
                      <span className="status-pill">Updated {formatUpdatedAt(profile.updatedAt)}</span>
                      {profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID ? (
                        <span className="status-pill status-good">Recommended baseline</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="wizard-actions profile-row-actions">
                    <button
                      type="button"
                      onClick={() => setActiveProfile(profile.profileId)}
                      disabled={working || activeProfileId === profile.profileId}
                    >
                      {activeProfileId === profile.profileId ? 'Active' : 'Set Active'}
                    </button>
                    <button type="button" onClick={() => openEditWizard(profile.profileId)} disabled={working}>
                      Edit
                    </button>
                    <button type="button" onClick={() => openCloneWizard(profile.profileId)} disabled={working}>
                      Clone
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteProfile(profile.profileId)}
                      disabled={working || profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID}
                      title={
                        profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID
                          ? 'Default keyboard profile is always available.'
                          : undefined
                      }
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="settings-collapsed-note">Controller profile tools are hidden in compact mode.</p>
        )}
      </section>

      <section className="panel" id="settings-boot-mode">
        <div className="settings-section-head">
          <div>
            <h2>Emulator Boot Mode</h2>
            <p className="settings-section-meta">Current mode: {formatBootModeLabel(bootMode)}</p>
          </div>
          {isCompactViewport ? (
            <button type="button" className="settings-section-toggle" onClick={() => toggleSectionVisibility('boot')}>
              {sectionVisibility.boot ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </div>
        {sectionVisibility.boot ? (
          <>
            <p>Choose the default core source strategy used when starting ROMs.</p>
            <label>
              Default boot mode
              <select
                value={bootMode}
                onChange={(event) => void onBootModeChange(event.target.value as EmulatorBootMode)}
                disabled={savingBootMode || working}
              >
                <option value="auto">Auto fallback (local then CDN)</option>
                <option value="local">Local cores only</option>
                <option value="cdn">CDN cores only</option>
              </select>
            </label>
          </>
        ) : (
          <p className="settings-collapsed-note">Boot source controls are hidden.</p>
        )}
      </section>

      <section className="panel" id="settings-save-experience">
        <div className="settings-section-head">
          <div>
            <h2>Save Experience</h2>
            <p className="settings-section-meta">
              Mode: {advancedSaveSlotsEnabled ? 'Advanced multi-slot' : 'Console-like autosave'}
            </p>
          </div>
          {isCompactViewport ? (
            <button type="button" className="settings-section-toggle" onClick={() => toggleSectionVisibility('save')}>
              {sectionVisibility.save ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </div>
        {sectionVisibility.save ? (
          <>
            <p>
              Default mode is console-like autosave/resume. Enable advanced mode to expose multiple save slots, slot
              switching, and manual import/export controls.
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={advancedSaveSlotsEnabled}
                onChange={(event) => void onAdvancedSaveSlotsToggle(event.target.checked)}
                disabled={savingSaveMode || working}
              />
              Enable advanced save slots (expert mode)
            </label>
          </>
        ) : (
          <p className="settings-collapsed-note">Save behavior controls are hidden.</p>
        )}
      </section>

      <section className="panel danger-panel" id="settings-danger-zone">
        <div className="settings-section-head">
          <div>
            <h2>Danger Zone</h2>
            <p className="settings-section-meta">Status: {clearConfirmOpen ? 'Armed confirmation step' : 'Locked'}</p>
          </div>
          {isCompactViewport ? (
            <button type="button" className="settings-section-toggle" onClick={() => toggleSectionVisibility('danger')}>
              {sectionVisibility.danger ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </div>
        {sectionVisibility.danger ? (
          <>
            <p>Clear all local catalog entries, binary imports, controller profiles, and save data.</p>
            <p className="settings-danger-hint">Type CLEAR to confirm this irreversible action.</p>
            {clearConfirmOpen ? (
              <div className="settings-danger-confirm">
                <label>
                  Confirmation text
                  <input
                    type="text"
                    value={clearConfirmValue}
                    onChange={(event) => setClearConfirmValue(event.target.value)}
                    placeholder="Type CLEAR"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="wizard-actions">
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void onClearData()}
                    disabled={working || clearConfirmValue.trim().toUpperCase() !== 'CLEAR'}
                  >
                    {working ? 'Working…' : 'Confirm Clear Local Data'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setClearConfirmOpen(false);
                      setClearConfirmValue('');
                    }}
                    disabled={working}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  setClearConfirmOpen(true);
                  setClearConfirmValue('');
                }}
                disabled={working}
              >
                {working ? 'Working…' : 'Clear All Local Data'}
              </button>
            )}
          </>
        ) : (
          <p className="settings-collapsed-note">Danger actions are hidden.</p>
        )}
      </section>

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            saveMode={wizardMode}
            initialProfile={wizardMode === 'edit' ? activeProfile : wizardTemplateProfile}
            onCancel={() => {
              setWizardOpen(false);
              setWizardMode('create');
              setWizardTemplateProfile(undefined);
            }}
            onComplete={onProfileComplete}
          />
        </div>
      ) : null}
    </section>
  );
}
