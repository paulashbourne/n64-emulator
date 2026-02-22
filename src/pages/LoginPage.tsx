import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuthStore } from '../state/authStore';

export function LoginPage() {
  const navigate = useNavigate();
  const status = useAuthStore((state) => state.status);
  const loginWithPassword = useAuthStore((state) => state.loginWithPassword);
  const storeError = useAuthStore((state) => state.authError);
  const clearAuthError = useAuthStore((state) => state.clearAuthError);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (status === 'authenticated') {
      navigate('/online');
    }
  }, [navigate, status]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    clearAuthError();
    try {
      await loginWithPassword({
        username,
        password,
      });
      navigate('/online');
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : 'Could not sign in.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel">
      <h2>Log In</h2>
      <p>Sign in to sync your profile and cloud saves across devices.</p>
      {error ? <p className="error-text">{error}</p> : null}
      {storeError ? <p className="warning-text">{storeError}</p> : null}
      <form className="online-session-form" onSubmit={onSubmit}>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <div className="wizard-actions">
          <button type="submit" className="preset-button" disabled={submitting}>
            {submitting ? 'Signing In…' : 'Log In'}
          </button>
          <Link to="/signup">Need an account?</Link>
        </div>
      </form>
    </section>
  );
}
