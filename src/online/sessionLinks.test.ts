import {
  buildInviteJoinUrl,
  buildSessionLibraryUrl,
  buildSessionPlayUrl,
  buildSessionRoute,
} from './sessionLinks';

describe('sessionLinks', () => {
  test('builds play URL with encoded session context', () => {
    const url = buildSessionPlayUrl('import:hash value', {
      onlineCode: 'AB C123',
      onlineClientId: 'client/id',
    });

    expect(url).toContain('/play/import%3Ahash%20value');
    expect(url).toContain('onlineCode=AB+C123');
    expect(url).toContain('onlineClientId=client%2Fid');
  });

  test('omits query when no session context is present', () => {
    expect(buildSessionPlayUrl('import:abc')).toBe('/play/import%3Aabc');
    expect(buildSessionLibraryUrl()).toBe('/');
    expect(buildSessionRoute()).toBeNull();
  });

  test('builds session route and invite links', () => {
    const route = buildSessionRoute({
      onlineCode: 'ZXCV12',
      onlineClientId: 'host-1',
    });
    expect(route).toBe('/online/session/ZXCV12?clientId=host-1');

    expect(buildInviteJoinUrl('ab12cd', 'https://example.com')).toBe('https://example.com/online?code=AB12CD');
  });
});
