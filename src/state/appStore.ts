import { create } from 'zustand';

import { createKeyboardPresetBindings } from '../input/mappingWizard';
import {
  deleteSharedControllerProfile,
  listSharedControllerProfiles,
  upsertSharedControllerProfiles,
} from '../online/multiplayerApi';
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
import type { InputBinding, N64ControlTarget } from '../types/input';

const DEFAULT_KEYBOARD_PROFILE_ID = 'profile:keyboard-default';
const DEFAULT_SWITCH_PROFILE_ID = 'profile:gamepad-switch';
const DEFAULT_XBOX_PROFILE_ID = 'profile:gamepad-xbox-series';
const DEFAULT_BACKBONE_PROFILE_ID = 'profile:gamepad-backbone';
const DEFAULT_8BITDO_PROFILE_ID = 'profile:gamepad-8bitdo-64';

type FaceLayout = 'xbox' | 'nintendo';

function button(index: number): InputBinding {
  return {
    source: 'gamepad_button',
    index,
  };
}

function axis(index: number, direction: 'negative' | 'positive', threshold = 0.3): InputBinding {
  return {
    source: 'gamepad_axis',
    index,
    direction,
    threshold,
  };
}

function axisDiscrete(index: number, axisValue: number, axisTolerance = 0.12): InputBinding {
  return {
    source: 'gamepad_axis',
    index,
    axisValue,
    axisTolerance,
  };
}

function createGamepadPresetBindings(layout: FaceLayout): Partial<Record<N64ControlTarget, InputBinding>> {
  const aFaceIndex = layout === 'nintendo' ? 1 : 0;
  const bFaceIndex = layout === 'nintendo' ? 0 : 1;

  return {
    a: button(aFaceIndex),
    b: button(bFaceIndex),
    z: button(6),
    start: button(9),
    l: button(4),
    r: button(5),
    dpad_up: button(12),
    dpad_down: button(13),
    dpad_left: button(14),
    dpad_right: button(15),
    c_up: axis(3, 'negative', 0.45),
    c_down: axis(3, 'positive', 0.45),
    c_left: axis(2, 'negative', 0.45),
    c_right: axis(2, 'positive', 0.45),
    analog_left: axis(0, 'negative', 0.2),
    analog_right: axis(0, 'positive', 0.2),
    analog_up: axis(1, 'negative', 0.2),
    analog_down: axis(1, 'positive', 0.2),
  };
}

function create8BitDo64PresetBindings(): Partial<Record<N64ControlTarget, InputBinding>> {
  return {
    a: button(0),
    b: button(1),
    z: button(8),
    start: button(11),
    l: button(6),
    r: button(7),
    // 8BitDo 64 exposes D-pad on a hat-style axis (axis 9) with discrete values.
    dpad_up: axisDiscrete(9, -1),
    dpad_down: axisDiscrete(9, 1 / 7),
    dpad_left: axisDiscrete(9, 5 / 7),
    dpad_right: axisDiscrete(9, -3 / 7),
    c_up: axis(5, 'negative', 0.4),
    c_down: axis(5, 'positive', 0.4),
    c_left: axis(2, 'negative', 0.4),
    c_right: axis(2, 'positive', 0.4),
    analog_left: axis(0, 'negative', 0.2),
    analog_right: axis(0, 'positive', 0.2),
    analog_up: axis(1, 'negative', 0.2),
    analog_down: axis(1, 'positive', 0.2),
  };
}

function isLegacy8BitDoPreset(profile: ControllerProfile): boolean {
  if (profile.profileId !== DEFAULT_8BITDO_PROFILE_ID) {
    return false;
  }

  const startBinding = profile.bindings.start;
  const dpadUpBinding = profile.bindings.dpad_up;

  return (
    startBinding?.source === 'gamepad_button'
    && startBinding.index === 9
    && dpadUpBinding?.source === 'gamepad_button'
    && dpadUpBinding.index === 12
  );
}

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

  await db.profiles.put({
    profileId: DEFAULT_KEYBOARD_PROFILE_ID,
    name: 'Keyboard Default',
    deviceId: 'keyboard-default',
    deadzone: 0.2,
    bindings: createKeyboardPresetBindings(),
    updatedAt: Date.now(),
  });
}

async function ensureDefaultGamepadProfiles(): Promise<void> {
  const now = Date.now();
  const templates: ControllerProfile[] = [
    {
      profileId: DEFAULT_SWITCH_PROFILE_ID,
      name: 'Nintendo Switch Controller',
      deviceId: 'preset-switch-controller',
      deadzone: 0.2,
      bindings: createGamepadPresetBindings('nintendo'),
      updatedAt: now,
    },
    {
      profileId: DEFAULT_XBOX_PROFILE_ID,
      name: 'Xbox Series X|S Controller',
      deviceId: 'preset-xbox-series-controller',
      deadzone: 0.2,
      bindings: createGamepadPresetBindings('xbox'),
      updatedAt: now,
    },
    {
      profileId: DEFAULT_BACKBONE_PROFILE_ID,
      name: 'Backbone Controller (iPhone)',
      deviceId: 'preset-backbone-controller',
      deadzone: 0.2,
      bindings: createGamepadPresetBindings('xbox'),
      updatedAt: now,
    },
    {
      profileId: DEFAULT_8BITDO_PROFILE_ID,
      name: '8BitDo 64 Bluetooth Controller',
      deviceId: 'preset-8bitdo-64-controller',
      deadzone: 0.2,
      bindings: create8BitDo64PresetBindings(),
      updatedAt: now,
    },
  ];

  const allProfiles = await db.profiles.toArray();
  const existingById = new Map(allProfiles.map((profile) => [profile.profileId, profile]));
  const missingProfiles: ControllerProfile[] = [];
  const upgradedProfiles: ControllerProfile[] = [];

  for (const template of templates) {
    const existing = existingById.get(template.profileId);
    if (!existing) {
      missingProfiles.push(template);
      continue;
    }

    if (template.profileId === DEFAULT_8BITDO_PROFILE_ID && isLegacy8BitDoPreset(existing)) {
      upgradedProfiles.push({
        ...existing,
        name: template.name,
        deviceId: template.deviceId,
        deadzone: template.deadzone,
        bindings: template.bindings,
        updatedAt: Math.max(now, existing.updatedAt + 1),
      });
    }
  }

  if (missingProfiles.length > 0 || upgradedProfiles.length > 0) {
    await db.profiles.bulkPut([...missingProfiles, ...upgradedProfiles]);
  }
}

function normalizeGlobalProfile(profile: ControllerProfile): ControllerProfile {
  return {
    ...profile,
    romHash: undefined,
  };
}

function normalizeBindingForComparison(binding: InputBinding): Record<string, string | number> {
  const normalized: Record<string, string | number> = {
    source: binding.source,
  };

  if (typeof binding.code === 'string') {
    normalized.code = binding.code;
  }
  if (typeof binding.index === 'number') {
    normalized.index = binding.index;
  }
  if (typeof binding.gamepadIndex === 'number') {
    normalized.gamepadIndex = binding.gamepadIndex;
  }
  if (typeof binding.deviceId === 'string') {
    normalized.deviceId = binding.deviceId;
  }
  if (binding.direction === 'negative' || binding.direction === 'positive') {
    normalized.direction = binding.direction;
  }
  if (typeof binding.threshold === 'number') {
    normalized.threshold = binding.threshold;
  }
  if (typeof binding.axisValue === 'number') {
    normalized.axisValue = binding.axisValue;
  }
  if (typeof binding.axisTolerance === 'number') {
    normalized.axisTolerance = binding.axisTolerance;
  }

  return normalized;
}

function profileMappingSignature(profile: ControllerProfile): string {
  const normalizedBindings: Array<[string, Record<string, string | number>]> = [];
  for (const [target, binding] of Object.entries(profile.bindings)) {
    if (!binding) {
      continue;
    }
    normalizedBindings.push([target, normalizeBindingForComparison(binding)]);
  }
  normalizedBindings.sort((left, right) => left[0].localeCompare(right[0]));

  return JSON.stringify({
    name: profile.name,
    deviceId: profile.deviceId,
    deadzone: profile.deadzone,
    bindings: normalizedBindings,
  });
}

function profilesHaveSameMappings(left: ControllerProfile, right: ControllerProfile): boolean {
  return profileMappingSignature(left) === profileMappingSignature(right);
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

async function listLocalGlobalProfiles(): Promise<ControllerProfile[]> {
  const allProfiles = await db.profiles.toArray();
  return allProfiles.filter((profile) => profile.romHash === undefined).map(normalizeGlobalProfile);
}

function toProfileMap(profiles: ControllerProfile[]): Map<string, ControllerProfile> {
  return new Map(profiles.map((profile) => [profile.profileId, profile]));
}

async function replaceLocalGlobalProfiles(profiles: ControllerProfile[]): Promise<void> {
  const allProfiles = await db.profiles.toArray();
  const globalProfileIds = allProfiles.filter((profile) => profile.romHash === undefined).map((profile) => profile.profileId);
  if (globalProfileIds.length > 0) {
    await db.profiles.bulkDelete(globalProfileIds);
  }
  if (profiles.length > 0) {
    await db.profiles.bulkPut(profiles.map(normalizeGlobalProfile));
  }
}

async function synchronizeGlobalProfilesFromServer(): Promise<void> {
  const localGlobalProfiles = await listLocalGlobalProfiles();
  const localById = toProfileMap(localGlobalProfiles);

  const remoteProfiles = (await listSharedControllerProfiles()).map(normalizeGlobalProfile);
  const remoteById = toProfileMap(remoteProfiles);

  const profilesToUpload: ControllerProfile[] = [];
  for (const localProfile of localGlobalProfiles) {
    const remoteProfile = remoteById.get(localProfile.profileId);
    if (!remoteProfile || localProfile.updatedAt > remoteProfile.updatedAt) {
      profilesToUpload.push(localProfile);
      continue;
    }

    if (!profilesHaveSameMappings(localProfile, remoteProfile)) {
      const rebasedLocalProfile: ControllerProfile = {
        ...localProfile,
        updatedAt: remoteProfile.updatedAt + 1,
      };
      profilesToUpload.push(rebasedLocalProfile);
      localById.set(rebasedLocalProfile.profileId, rebasedLocalProfile);
    }
  }

  let mergedById = new Map(remoteById);
  if (profilesToUpload.length > 0) {
    const uploadedProfiles = await upsertSharedControllerProfiles(profilesToUpload);
    mergedById = toProfileMap(uploadedProfiles.map(normalizeGlobalProfile));
  } else if (remoteProfiles.length === 0 && localGlobalProfiles.length > 0) {
    const uploadedProfiles = await upsertSharedControllerProfiles(localGlobalProfiles);
    mergedById = toProfileMap(uploadedProfiles.map(normalizeGlobalProfile));
  }

  if (mergedById.size === 0 && localById.size > 0) {
    mergedById = new Map(localById);
  }

  await replaceLocalGlobalProfiles([...mergedById.values()]);
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
    await ensureDefaultGamepadProfiles();
    await migrateScopedProfilesToGlobal();
    try {
      await synchronizeGlobalProfilesFromServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown profile sync error.';
      console.warn(`Controller profile sync unavailable: ${message}`);
    }
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

    void (async () => {
      try {
        await synchronizeGlobalProfilesFromServer();
        const syncedProfiles = await queryProfiles();
        set((state) => ({
          profiles: syncedProfiles,
          activeProfileId: resolveActiveProfileId(syncedProfiles, state.activeProfileId ?? normalizedProfile.profileId),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown profile sync error.';
        console.warn(`Unable to persist profile to shared store: ${message}`);
      }
    })();
  },

  removeProfile: async (profileId: string) => {
    await db.profiles.delete(profileId);
    try {
      await deleteSharedControllerProfile(profileId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown profile sync error.';
      console.warn(`Unable to delete profile from shared store: ${message}`);
    }
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
