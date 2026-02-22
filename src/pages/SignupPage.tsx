import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuthStore } from '../state/authStore';

export function SignupPage() {
  const navigate = useNavigate();
  const status = useAuthStore((state) => state.status);
  const signupWithPassword = useAuthStore((state) => state.signupWithPassword);
  const storeError = useAuthStore((state) => state.authError);
  const clearAuthError = useAuthStore((state) => state.clearAuthError);

  const [email, setEmail] = useState('');
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
      await signupWithPassword({
        email,
        username,
        password,
      });
      navigate('/online');
    } catch (signupError) {
      const message = signupError instanceof Error ? signupError.message : 'Could not create account.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel">
      <h2>Sign Up</h2>
      <p>Create an account to sync your profile and cloud saves.</p>
      {error ? <p className="error-text">{error}</p> : null}
      {storeError ? <p className="warning-text">{storeError}</p> : null}
      <form className="online-session-form" onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>
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
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <div className="wizard-actions">
          <button type="submit" className="preset-button" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Account'}
          </button>
          <Link to="/login">Already have an account?</Link>
        </div>
      </form>
    </section>
  );
}
