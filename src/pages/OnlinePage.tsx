import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { createOnlineSession, joinOnlineSession } from '../online/multiplayerApi';
import { useAppStore } from '../state/appStore';

const NO_ROM_SELECTED = '__none__';

export function OnlinePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const roms = useAppStore((state) => state.roms);
  const refreshRoms = useAppStore((state) => state.refreshRoms);

  const [hostName, setHostName] = useState('Player 1');
  const [joinName, setJoinName] = useState('Player');
  const [selectedRomId, setSelectedRomId] = useState<string>(NO_ROM_SELECTED);
  const [joinCode, setJoinCode] = useState((searchParams.get('code') ?? '').trim().toUpperCase());
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    void refreshRoms();
  }, [refreshRoms]);

  const selectedRom = useMemo(
    () => roms.find((rom) => rom.id === selectedRomId && selectedRomId !== NO_ROM_SELECTED),
    [roms, selectedRomId],
  );

  const onCreateSession = async (): Promise<void> => {
    setError(undefined);
    setCreating(true);
    try {
      const created = await createOnlineSession({
        hostName,
        romId: selectedRom?.id,
        romTitle: selectedRom?.title,
      });
      navigate(`/online/session/${created.code}?clientId=${encodeURIComponent(created.clientId)}`);
    } catch (sessionError) {
      const message = sessionError instanceof Error ? sessionError.message : 'Failed to create session.';
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const onJoinSession = async (): Promise<void> => {
    setError(undefined);
    setJoining(true);
    try {
      const joined = await joinOnlineSession({
        code: joinCode,
        name: joinName,
      });
      navigate(`/online/session/${joined.code}?clientId=${encodeURIComponent(joined.clientId)}`);
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : 'Failed to join session.';
      setError(message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <section className="online-page">
      <header className="panel">
        <h1>Online Multiplayer</h1>
        <p>Host runs the ROM as Player 1. Friends join with an invite code and take slots 2-4.</p>
        <p>
          <strong>Architecture:</strong> central coordinator + host-authoritative input relay.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
      </header>

      <div className="online-page-grid">
        <section className="panel online-card">
          <h2>Start Game</h2>
          <p>Create a session, share the invite code, then launch your ROM as host.</p>
          <div className="online-form-grid">
            <label>
              Host Name
              <input
                type="text"
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
                maxLength={32}
              />
            </label>

            <label>
              ROM (optional)
              <select
                value={selectedRomId}
                onChange={(event) => setSelectedRomId(event.target.value)}
              >
                <option value={NO_ROM_SELECTED}>Choose Later in Library</option>
                {roms.map((rom) => (
                  <option key={rom.id} value={rom.id}>
                    {rom.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="online-subtle">
            {selectedRom
              ? `Session will preselect "${selectedRom.title}".`
              : 'No ROM preselected. You can choose one after session creation.'}
          </p>
          <div className="wizard-actions">
            <button type="button" onClick={() => void onCreateSession()} disabled={creating || joining}>
              {creating ? 'Creating…' : 'Start Online Game'}
            </button>
            <Link to="/">Back to Library</Link>
          </div>
        </section>

        <section className="panel online-card">
          <h2>Join Game</h2>
          <p>Enter your friend&apos;s invite code to join as the next available player slot.</p>
          <div className="online-form-grid">
            <label>
              Your Name
              <input
                type="text"
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
                maxLength={32}
              />
            </label>

            <label>
              Invite Code
              <input
                type="text"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
            </label>
          </div>
          <div className="wizard-actions">
            <button type="button" onClick={() => void onJoinSession()} disabled={joining || creating || joinCode.trim().length < 4}>
              {joining ? 'Joining…' : 'Join by Invite Code'}
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
