function parseBooleanFlag(name: string, fallback: boolean): boolean {
  const env = import.meta.env as Record<string, unknown>;
  const rawValue = env[name];
  if (typeof rawValue !== 'string') {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return fallback;
}

export const UX_FEEDBACK_V2_ENABLED = parseBooleanFlag('VITE_UX_FEEDBACK_V2', true);
export const UX_ONBOARDING_V2_ENABLED = parseBooleanFlag('VITE_UX_ONBOARDING_V2', true);
export const UX_PLAY_NAV_V2_ENABLED = parseBooleanFlag('VITE_UX_PLAY_NAV_V2', true);
export const UX_ONLINE_FLOW_V2_ENABLED = parseBooleanFlag('VITE_UX_ONLINE_FLOW_V2', true);
export const UX_PREF_SYNC_V1_ENABLED = parseBooleanFlag('VITE_UX_PREF_SYNC_V1', true);
