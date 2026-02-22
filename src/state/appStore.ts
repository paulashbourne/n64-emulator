import { create } from 'zustand';

import {
  DEFAULT_KEYBOARD_PROFILE_ID,
  PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
  createKeyboardDefaultProfile,
  createPreconfiguredGamepadProfileTemplate,
  isLegacy8BitDoPreset,
} from '../input/controllerProfilePresets';
import {
  getPreferredFavoritesOnly,
  getPreferredLibrarySortMode,
  setPreferredFavoritesOnly,
  setPreferredLibrarySortMode,
} from '../storage/appSettings';
import { db } from '../storage/db';
import type { ControllerProfile } from '../types/input';
import type { RomRecord } from '../types/rom';
import {
  importRomFilesDetailed,
  listRoms,
  markRomPlayed,
  pickAndIndexDirectory,
  removeRomFromCatalog,
  reindexKnownDirectories,
  setRomFavorite,
  supportsDirectoryPicker,
  type RomSortMode,
} from '../roms/catalogService';

interface AppStoreState {
  roms: RomRecord[];
  searchTerm: string;
  sortMode: RomSortMode;
  favoritesOnly: boolean;
  loadingRoms: boolean;
  romError?: string;
  profiles: ControllerProfile[];
  activeProfileId?: string;
  browserSupportsDirectoryPicker: boolean;
  emulatorWarning?: string;
  refreshRoms: () => Promise<void>;
  hydrateLibraryPreferences: () => Promise<void>;
  setSearchTerm: (term: string) => Promise<void>;
  setSortMode: (mode: RomSortMode) => Promise<void>;
  setFavoritesOnly: (enabled: boolean) => Promise<void>;
  indexDirectory: () => Promise<void>;
  reindexDirectories: () => Promise<number>;
  importFiles: (files: File[]) => Promise<{ imported: number; skipped: number; total: number }>;
  removeRom: (romId: string) => Promise<void>;
  toggleFavorite: (romId: string) => Promise<void>;
  setRomError: (error?: string) => void;
  clearRomError: () => void;
  loadProfiles: (romHash?: string) => Promise<void>;
  saveProfile: (profile: ControllerProfile) => Promise<void>;
  removeProfile: (profileId: string) => Promise<void>;
  setActiveProfile: (profileId?: string) => void;
  markLastPlayed: (romId: string) => Promise<void>;
  setEmulatorWarning: (warning?: string) => void;
}

async function ensureDefaultKeyboardProfile(): Promise<void> {
  const existing = await db.profiles.get(DEFAULT_KEYBOARD_PROFILE_ID);
  if (existing) {
    return;
  }

  await db.profiles.put(createKeyboardDefaultProfile());
}

async function upgradeLegacyPresetProfiles(): Promise<void> {
  const existing8BitDo = await db.profiles.get(PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID);
  if (!existing8BitDo || !isLegacy8BitDoPreset(existing8BitDo)) {
    return;
  }

  const upgradedTemplate = createPreconfiguredGamepadProfileTemplate(
    PRECONFIGURED_8BITDO_PROFILE_TEMPLATE_ID,
    Math.max(Date.now(), existing8BitDo.updatedAt + 1),
  );

  if (!upgradedTemplate) {
    return;
  }

  await db.profiles.put({
    ...existing8BitDo,
    name: upgradedTemplate.name,
    deviceId: upgradedTemplate.deviceId,
    deadzone: upgradedTemplate.deadzone,
    bindings: upgradedTemplate.bindings,
    updatedAt: upgradedTemplate.updatedAt,
  });
}

function normalizeGlobalProfile(profile: ControllerProfile): ControllerProfile {
  return {
    ...profile,
    romHash: undefined,
  };
}

function resolveActiveProfileId(profiles: ControllerProfile[], preferredProfileId?: string): string | undefined {
  if (preferredProfileId && profiles.some((profile) => profile.profileId === preferredProfileId)) {
    return preferredProfileId;
  }

  return profiles.find((profile) => profile.profileId === DEFAULT_KEYBOARD_PROFILE_ID)?.profileId ?? profiles[0]?.profileId;
}

async function migrateScopedProfilesToGlobal(): Promise<void> {
  const allProfiles = await db.profiles.toArray();
  const scopedProfiles = allProfiles.filter((profile) => profile.romHash !== undefined);
  if (scopedProfiles.length === 0) {
    return;
  }

  await db.profiles.bulkPut(scopedProfiles.map(normalizeGlobalProfile));
}

async function queryProfiles(romHash?: string): Promise<ControllerProfile[]> {
  const allProfiles = await db.profiles.toArray();

  const filtered =
    romHash === undefined
      ? allProfiles
      : allProfiles.filter((profile) => profile.romHash === undefined || profile.romHash === romHash);

  return filtered.sort((left, right) => right.updatedAt - left.updatedAt);
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  roms: [],
  searchTerm: '',
  sortMode: 'title',
  favoritesOnly: false,
  loadingRoms: false,
  romError: undefined,
  profiles: [],
  activeProfileId: undefined,
  browserSupportsDirectoryPicker: supportsDirectoryPicker(),
  emulatorWarning: undefined,

  refreshRoms: async () => {
    set({ loadingRoms: true });
    try {
      const { searchTerm, sortMode, favoritesOnly } = get();
      const roms = await listRoms({
        search: searchTerm,
        sort: sortMode,
        favoritesOnly,
      });
      set({ roms, romError: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh ROM list.';
      set({ romError: message });
    } finally {
      set({ loadingRoms: false });
    }
  },

  hydrateLibraryPreferences: async () => {
    try {
      const [preferredSortMode, preferredFavoritesOnly] = await Promise.all([
        getPreferredLibrarySortMode(),
        getPreferredFavoritesOnly(),
      ]);
      set({
        sortMode: preferredSortMode,
        favoritesOnly: preferredFavoritesOnly,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load saved library preferences.';
      set({ romError: message });
    }
  },

  setSearchTerm: async (term: string) => {
    set({ searchTerm: term });
    await get().refreshRoms();
  },

  setSortMode: async (mode: RomSortMode) => {
    try {
      set({ sortMode: mode });
      await setPreferredLibrarySortMode(mode);
      await get().refreshRoms();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to persist library sort mode.';
      set({ romError: message });
    }
  },

  setFavoritesOnly: async (enabled: boolean) => {
    try {
      set({ favoritesOnly: enabled });
      await setPreferredFavoritesOnly(enabled);
      await get().refreshRoms();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to persist favorites filter.';
      set({ romError: message });
    }
  },

  indexDirectory: async () => {
    set({ loadingRoms: true });
    try {
      await pickAndIndexDirectory();
      await get().refreshRoms();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to index folder.';
      set({ romError: message });
    } finally {
      set({ loadingRoms: false });
    }
  },

  reindexDirectories: async () => {
    set({ loadingRoms: true });
    try {
      const indexedCount = await reindexKnownDirectories();
      await get().refreshRoms();
      return indexedCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reindex stored folders.';
      set({ romError: message });
      return 0;
    } finally {
      set({ loadingRoms: false });
    }
  },

  importFiles: async (files: File[]) => {
    if (files.length === 0) {
      return { imported: 0, skipped: 0, total: 0 };
    }

    set({ loadingRoms: true });
    try {
      const result = await importRomFilesDetailed(files);
      await get().refreshRoms();
      if (result.imported.length === 0) {
        set({ romError: 'No valid N64 ROM files were found in your selection.' });
      }
      return {
        imported: result.imported.length,
        skipped: result.skipped,
        total: result.total,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import ROM files.';
      set({ romError: message });
      return { imported: 0, skipped: files.length, total: files.length };
    } finally {
      set({ loadingRoms: false });
    }
  },

  removeRom: async (romId: string) => {
    set({ loadingRoms: true });
    try {
      await removeRomFromCatalog(romId);
      await get().refreshRoms();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove ROM from catalog.';
      set({ romError: message });
    } finally {
      set({ loadingRoms: false });
    }
  },

  toggleFavorite: async (romId: string) => {
    set({ loadingRoms: true });
    try {
      await setRomFavorite(romId);
      await get().refreshRoms();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update ROM favorite state.';
      set({ romError: message });
    } finally {
      set({ loadingRoms: false });
    }
  },

  setRomError: (error?: string) => {
    set({ romError: error });
  },

  clearRomError: () => {
    set({ romError: undefined });
  },

  loadProfiles: async (romHash?: string) => {
    await ensureDefaultKeyboardProfile();
    await upgradeLegacyPresetProfiles();
    await migrateScopedProfilesToGlobal();
    const profiles = await queryProfiles(romHash);
    const activeProfileId = get().activeProfileId;

    set({
      profiles,
      activeProfileId: resolveActiveProfileId(profiles, activeProfileId),
    });
  },

  saveProfile: async (profile: ControllerProfile) => {
    const normalizedProfile = normalizeGlobalProfile(profile);
    await db.profiles.put(normalizedProfile);

    const localProfiles = await queryProfiles();
    set({
      profiles: localProfiles,
      activeProfileId: resolveActiveProfileId(localProfiles, normalizedProfile.profileId),
    });
  },

  removeProfile: async (profileId: string) => {
    await db.profiles.delete(profileId);
    await get().loadProfiles();
  },

  setActiveProfile: (profileId?: string) => {
    set({ activeProfileId: profileId });
  },

  markLastPlayed: async (romId: string) => {
    await markRomPlayed(romId);
    await get().refreshRoms();
  },

  setEmulatorWarning: (warning?: string) => {
    set({ emulatorWarning: warning });
  },
}));
