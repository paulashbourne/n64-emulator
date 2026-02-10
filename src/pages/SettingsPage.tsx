import { useEffect, useState } from 'react';

import type { EmulatorBootMode } from '../emulator/emulatorJsRuntime';
import { clearIndexedData } from '../storage/db';
import { getPreferredBootMode, setPreferredBootMode } from '../storage/appSettings';
import { useAppStore } from '../state/appStore';

export function SettingsPage() {
  const profiles = useAppStore((state) => state.profiles);
  const loadProfiles = useAppStore((state) => state.loadProfiles);
  const removeProfile = useAppStore((state) => state.removeProfile);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const [working, setWorking] = useState(false);
  const [savingBootMode, setSavingBootMode] = useState(false);
  const [bootMode, setBootMode] = useState<EmulatorBootMode>('auto');
  const [message, setMessage] = useState<string>();

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

  return (
    <section className="settings-page">
      <header className="panel">
        <h1>Settings</h1>
        <p>Manage controller profiles and local emulator data.</p>
        {message ? <p>{message}</p> : null}
      </header>

      <section className="panel">
        <h2>Controller Profiles</h2>
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
              </div>
              <button type="button" onClick={() => void onDeleteProfile(profile.profileId)} disabled={working}>
                Delete
              </button>
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
    </section>
  );
}
