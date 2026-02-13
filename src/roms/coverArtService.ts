import type { RomRecord } from '../types/rom';
import { N64_COVER_INVENTORY, type N64CoverInventoryEntry } from './n64CoverInventory';

export interface RomCoverArtMatch {
  title: string;
  url: string;
  file: string;
  matchType: 'exact' | 'compact' | 'alias' | 'fuzzy';
}

interface IndexedCoverEntry extends N64CoverInventoryEntry {
  normalizedTitle: string;
  compactTitle: string;
  tokens: string[];
}

const COMMON_TOKENS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'edition', 'version', 'rev']);

const TITLE_ALIASES: Record<string, string> = {
  mariokart64: 'mario kart 64',
  marioparty: 'mario party',
  marioparty2: 'mario party 2',
  marioparty3: 'mario party 3',
  papermario: 'paper mario',
  banjotooie: 'banjo tooie',
  banjokazooie: 'banjo kazooie',
  conkersbadfurday: 'conkers bad fur day',
  drmario64: 'dr mario 64',
  diddykongracing: 'diddy kong racing',
  donkeykong64: 'donkey kong 64',
  '1080snowboarding': '1080 snowboarding',
  cruisnusa: 'cruis n usa',
  cruisnworld: 'cruis n world',
  turok2seedsofevil: 'turok 2 seeds of evil',
  supermario64: 'super mario 64',
  zeldamajorasmask: 'legend of zelda the majoras mask',
  zeldaocarinaoftime: 'legend of zelda the ocarina of time',
  thelegendofzelda: 'legend of zelda the ocarina of time',
  legendofzelda: 'legend of zelda the ocarina of time',
  waverace64: 'wave race 64',
  starfox64: 'star fox 64',
  goldeneye: 'goldeneye 007',
};

function reorderTrailingArticle(value: string): string {
  const match = value.match(/^(.+),\s*(the|a|an)$/i);
  if (!match) {
    return value;
  }
  return `${match[2]} ${match[1]}`;
}

export function normalizeCoverTitle(rawValue: string): string {
  return reorderTrailingArticle(rawValue)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`"]/g, '')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactTitle(value: string): string {
  return value.replace(/\s+/g, '');
}

function titleTokens(normalizedTitle: string): string[] {
  return normalizedTitle
    .split(' ')
    .filter((token) => token.length > 0 && !COMMON_TOKENS.has(token));
}

function parseRelativePathTitle(relativePath: string | undefined): string | null {
  if (!relativePath) {
    return null;
  }

  const pieces = relativePath.split('/');
  const fileName = pieces[pieces.length - 1] ?? '';
  if (!fileName) {
    return null;
  }

  return fileName.replace(/\.[a-z0-9]+$/i, '').trim() || null;
}

function buildCandidateTitles(rom: Pick<RomRecord, 'title' | 'relativePath'>): string[] {
  const candidates = new Set<string>();
  candidates.add(rom.title);

  const fileTitle = parseRelativePathTitle(rom.relativePath);
  if (fileTitle) {
    candidates.add(fileTitle);
  }

  // Handle compact names like "MARIOKART64" by inserting whitespace around numeric boundaries.
  if (/^[a-z0-9]+$/i.test(rom.title) && !/\s/.test(rom.title)) {
    const expanded = rom.title
      .replace(/([a-z])([0-9])/gi, '$1 $2')
      .replace(/([0-9])([a-z])/gi, '$1 $2');
    candidates.add(expanded);
  }

  return Array.from(candidates);
}

const INDEXED_COVERS: IndexedCoverEntry[] = N64_COVER_INVENTORY.map((entry) => {
  const normalizedTitle = normalizeCoverTitle(entry.title);
  return {
    ...entry,
    normalizedTitle,
    compactTitle: compactTitle(normalizedTitle),
    tokens: titleTokens(normalizedTitle),
  };
});

const COVER_BY_NORMALIZED = new Map<string, IndexedCoverEntry>();
const COVER_BY_COMPACT = new Map<string, IndexedCoverEntry>();

for (const entry of INDEXED_COVERS) {
  COVER_BY_NORMALIZED.set(entry.normalizedTitle, entry);
  COVER_BY_COMPACT.set(entry.compactTitle, entry);
}

function matchAlias(compactCandidate: string): IndexedCoverEntry | null {
  const alias = TITLE_ALIASES[compactCandidate];
  if (!alias) {
    return null;
  }
  const normalizedAlias = normalizeCoverTitle(alias);
  return COVER_BY_NORMALIZED.get(normalizedAlias) ?? COVER_BY_COMPACT.get(compactTitle(normalizedAlias)) ?? null;
}

function fuzzyFind(normalizedCandidate: string): IndexedCoverEntry | null {
  const candidateTokens = titleTokens(normalizedCandidate);
  if (candidateTokens.length < 2) {
    return null;
  }

  const candidateTokenSet = new Set(candidateTokens);
  const candidateCompact = compactTitle(normalizedCandidate);
  let best: { entry: IndexedCoverEntry; score: number; tokenDelta: number } | null = null;

  for (const entry of INDEXED_COVERS) {
    let overlap = 0;
    for (const token of entry.tokens) {
      if (candidateTokenSet.has(token)) {
        overlap += 1;
      }
    }

    if (overlap < 2) {
      continue;
    }

    const tokenScore = overlap / Math.max(entry.tokens.length, candidateTokens.length);
    let score = tokenScore;
    const tokenDelta = Math.abs(entry.tokens.length - candidateTokens.length);

    if (entry.compactTitle.includes(candidateCompact) || candidateCompact.includes(entry.compactTitle)) {
      score += 0.18;
    }

    if (entry.tokens[0] === candidateTokens[0]) {
      score += 0.04;
    }

    if (
      best === null ||
      score > best.score ||
      (score === best.score && tokenDelta < best.tokenDelta)
    ) {
      best = { entry, score, tokenDelta };
    }
  }

  const minimumScore = candidateTokens.length <= 2 ? 0.62 : 0.7;
  if (!best || best.score < minimumScore) {
    return null;
  }

  return best.entry;
}

export function matchRomCoverArt(rom: Pick<RomRecord, 'title' | 'relativePath'>): RomCoverArtMatch | null {
  const candidateTitles = buildCandidateTitles(rom);

  for (const candidate of candidateTitles) {
    const normalizedCandidate = normalizeCoverTitle(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    const exactMatch = COVER_BY_NORMALIZED.get(normalizedCandidate);
    if (exactMatch) {
      return {
        title: exactMatch.title,
        file: exactMatch.file,
        url: exactMatch.url,
        matchType: 'exact',
      };
    }

    const compactCandidate = compactTitle(normalizedCandidate);

    const compactMatch = COVER_BY_COMPACT.get(compactCandidate);
    if (compactMatch) {
      return {
        title: compactMatch.title,
        file: compactMatch.file,
        url: compactMatch.url,
        matchType: 'compact',
      };
    }

    const aliasMatch = matchAlias(compactCandidate);
    if (aliasMatch) {
      return {
        title: aliasMatch.title,
        file: aliasMatch.file,
        url: aliasMatch.url,
        matchType: 'alias',
      };
    }

    const fuzzyMatch = fuzzyFind(normalizedCandidate);
    if (fuzzyMatch) {
      return {
        title: fuzzyMatch.title,
        file: fuzzyMatch.file,
        url: fuzzyMatch.url,
        matchType: 'fuzzy',
      };
    }
  }

  return null;
}

export function coverInventorySize(): number {
  return INDEXED_COVERS.length;
}
