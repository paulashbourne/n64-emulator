import { useEffect, useState } from 'react';

import { ControllerWizard } from '../components/ControllerWizard';
import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import { clearIndexedData } from '../storage/db';
import { getPreferredBootMode, setPreferredBootMode } from '../storage/appSettings';
import { useAppStore } from '../state/appStore';
import type { ControllerProfile } from '../types/input';

const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';
type WizardMode = 'create' | 'edit';

export function SettingsPage() {
  const profiles = useAppStore((state) => state.profiles);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const loadProfiles = useAppStore((state) => state.loadProfiles);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const removeProfile = useAppStore((state) => state.removeProfile);
  const setActiveProfile = useAppStore((state) => state.setActiveProfile);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const [working, setWorking] = useState(false);
  const [savingBootMode, setSavingBootMode] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [message, setMessage] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>('create');

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    const loadBootMode = async (): Promise<void> => {
      const mode = await getPreferredBootMode();
      if (!cancelled) {
        setBootMode(mode);
      }
    };
    void loadBootMode();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProfile = profiles.find((profile) => profile.profileId === activeProfileId);

  const onDeleteProfile = async (profileId: string): Promise<void> => {
    setWorking(true);
    setMessage(undefined);
    try {
      await removeProfile(profileId);
      setMessage('Profile removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to remove profile.');
    } finally {
      setWorking(false);
    }
  };

  const onClearData = async (): Promise<void> => {
    setWorking(true);
    setMessage(undefined);
    try {
      await clearIndexedData();
      await refreshRoms();
      await loadProfiles();
      setMessage('Indexed ROMs, saves, and profiles were cleared.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to clear data.');
    } finally {
      setWorking(false);
    }
  };

  const onBootModeChange = async (mode: EmulatorBootMode): Promise<void> => {
    setSavingBootMode(true);
    setMessage(undefined);
    try {
      await setPreferredBootMode(mode);
      setBootMode(mode);
      setMessage(`Saved default boot mode: ${mode === 'auto' ? 'Auto fallback' : mode === 'local' ? 'Local cores only' : 'CDN cores only'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save boot mode.');
    } finally {
      setSavingBootMode(false);
    }
  };

  const openCreateWizard = (): void => {
    setWizardMode('create');
    setWizardOpen(true);
  };

  const openEditWizard = (profileId?: string): void => {
    if (!profileId) {
      openCreateWizard();
      return;
    }

    setActiveProfile(profileId);
    setWizardMode('edit');
    setWizardOpen(true);
  };

  const onProfileComplete = async (profile: ControllerProfile): Promise<void> => {
    await saveProfile(profile);
    setActiveProfile(profile.profileId);
    setWizardOpen(false);
    setWizardMode('create');
    setMessage(`Saved controller profile "${profile.name}".`);
  };

  return (
    <section className="settings-page">
      <header className="panel">
        <h1>Settings</h1>
        <p>Manage controller profiles and local emulator data.</p>
        {message ? <p>{message}</p> : null}
      </header>

      <section className="panel">
        <h2>Controller Profiles</h2>
        <div className="wizard-actions">
          <button type="button" onClick={openCreateWizard} disabled={working}>
            Create Profile
          </button>
          <button type="button" onClick={() => openEditWizard(activeProfileId)} disabled={working || !activeProfile}>
            Edit Active
          </button>
        </div>
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
        <ul className="profile-list">
          {profiles.map((profile) => (
            <li key={profile.profileId}>
              <div>
                <strong>{profile.name}</strong>
                <p>
                  Device: {profile.deviceId} • Deadzone: {profile.deadzone.toFixed(2)}
                  {profile.romHash ? ` • ROM-specific (${profile.romHash.slice(0, 12)}…)` : ' • Global'}
                </p>
                <p>
                  {Object.keys(profile.bindings).length} mapped controls
                  {profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID ? ' • Recommended baseline profile' : ''}
                </p>
              </div>
              <div className="wizard-actions">
                <button type="button" onClick={() => openEditWizard(profile.profileId)} disabled={working}>
                  Edit
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
      </section>

      <section className="panel">
        <h2>Emulator Boot Mode</h2>
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
      </section>

      <section className="panel danger-panel">
        <h2>Danger Zone</h2>
        <p>Clear all local catalog entries, binary imports, controller profiles, and save data.</p>
        <button type="button" className="danger-button" onClick={() => void onClearData()} disabled={working}>
          {working ? 'Working…' : 'Clear All Local Data'}
        </button>
      </section>

      {wizardOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <ControllerWizard
            initialProfile={wizardMode === 'edit' ? activeProfile : undefined}
            onCancel={() => {
              setWizardOpen(false);
              setWizardMode('create');
            }}
            onComplete={onProfileComplete}
          />
        </div>
      ) : null}
    </section>
  );
}
