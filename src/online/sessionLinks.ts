export interface OnlineSessionContext {
  onlineCode?: string;
  onlineClientId?: string;
}

function hasSessionContext(context?: OnlineSessionContext): context is Required<OnlineSessionContext> {
  return Boolean(context?.onlineCode && context?.onlineClientId);
}

function encodedSessionQuery(context?: OnlineSessionContext): string {
  if (!hasSessionContext(context)) {
    return '';
  }

  const params = new URLSearchParams();
  params.set('onlineCode', context.onlineCode);
  params.set('onlineClientId', context.onlineClientId);
  return params.toString();
}

export function buildSessionPlayUrl(romId: string, context?: OnlineSessionContext): string {
  const basePath = `/play/${encodeURIComponent(romId)}`;
  const query = encodedSessionQuery(context);
  return query ? `${basePath}?${query}` : basePath;
}

export function buildSessionLibraryUrl(context?: OnlineSessionContext): string {
  const query = encodedSessionQuery(context);
  return query ? `/?${query}` : '/';
}

export function buildSessionRoute(context?: OnlineSessionContext): string | null {
  if (!hasSessionContext(context)) {
    return null;
  }

  return `/online/session/${encodeURIComponent(context.onlineCode)}?clientId=${encodeURIComponent(context.onlineClientId)}`;
}

export function buildInviteJoinUrl(inviteCode: string, origin: string): string {
  return `${origin}/online?code=${encodeURIComponent(inviteCode.trim().toUpperCase())}`;
}
