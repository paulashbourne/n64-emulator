import { coverInventorySize, matchRomCoverArt, normalizeCoverTitle } from './coverArtService';

describe('cover art service', () => {
  test('normalizes cover titles consistently', () => {
    expect(normalizeCoverTitle("Bug's Life, A")).toBe('a bugs life');
    expect(normalizeCoverTitle('MARIOKART64')).toBe('mariokart64');
    expect(normalizeCoverTitle('Cruis’n USA')).toBe('cruisn usa');
  });

  test('matches compact ROM names such as MARIOKART64', () => {
    const match = matchRomCoverArt({
      title: 'MARIOKART64',
      relativePath: undefined,
    });

    expect(match).not.toBeNull();
    expect(match?.title).toBe('Mario Kart 64');
  });

  test('matches GOLDENEYE to GoldenEye 007 via alias', () => {
    const match = matchRomCoverArt({
      title: 'GOLDENEYE',
      relativePath: undefined,
    });

    expect(match).not.toBeNull();
    expect(match?.title).toBe('GoldenEye 007');
  });

  test('matches generic THE LEGEND OF ZELDA header to catalog cover', () => {
    const match = matchRomCoverArt({
      title: 'THE LEGEND OF ZELDA',
      relativePath: undefined,
    });

    expect(match).not.toBeNull();
    expect(match?.title).toContain('Legend of Zelda');
  });

  test('matches based on file path title when header title is noisy', () => {
    const match = matchRomCoverArt({
      title: 'N64 GAME DEMO',
      relativePath: 'imports/Banjo-Tooie (USA).z64',
    });

    expect(match).not.toBeNull();
    expect(match?.title).toBe('Banjo-Tooie');
  });

  test('returns null when no close cover exists', () => {
    const match = matchRomCoverArt({
      title: 'Totally Invented Homebrew Challenge',
      relativePath: undefined,
    });

    expect(match).toBeNull();
  });

  test('loads a large N64 cover inventory', () => {
    expect(coverInventorySize()).toBeGreaterThan(500);
  });
});
