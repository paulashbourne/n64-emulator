import type { EmulatorJsControls } from './emulatorJsControls';

const LOCAL_DATA_PATH = '/emulatorjs/data/';
const CDN_DATA_PATH = 'https://cdn.emulatorjs.org/stable/data/';
const N64_CORE_CANDIDATES = ['parallel_n64', 'mupen64plus_next'] as const;
type N64CoreId = (typeof N64_CORE_CANDIDATES)[number];

const LOADER_SCRIPT_ATTR = 'data-ejs-loader';
const BUILT_IN_TOUCH_GAMEPAD_OPTIONS: Record<string, string> = {
  'virtual-gamepad': 'disabled',
  'virtual-gamepad-left-handed-mode': 'disabled',
  'menu-bar-button': 'hidden',
};

export type EmulatorBootMode = 'auto' | 'local' | 'cdn';
export type EmulatorDataSource = 'local' | 'cdn';
export type EmulatorCoreId = N64CoreId;

function loaderUrl(dataPath: string): string {
  const normalized = dataPath.endsWith('/') ? dataPath : `${dataPath}/`;
  return `${normalized}loader.js`;
}

function dataPathForSource(source: EmulatorDataSource): string {
  return source === 'local' ? LOCAL_DATA_PATH : CDN_DATA_PATH;
}

function orderedSourcesForMode(mode: EmulatorBootMode): EmulatorDataSource[] {
  if (mode === 'local') {
    return ['local'];
  }
  if (mode === 'cdn') {
    return ['cdn'];
  }
  return ['local', 'cdn'];
}

function clearLoaderScripts(): void {
  const scripts = document.querySelectorAll(`script[${LOADER_SCRIPT_ATTR}]`);
  scripts.forEach((script) => script.remove());
}

function clearEmulatorGlobals(): void {
  delete window.EJS_player;
  delete window.EJS_gameName;
  delete window.EJS_biosUrl;
  delete window.EJS_gameUrl;
  delete window.EJS_core;
  delete window.EJS_pathtodata;
  delete window.EJS_startOnLoaded;
  delete window.EJS_DEBUG_XX;
  delete window.EJS_disableDatabases;
  delete window.EJS_threads;
  delete window.EJS_defaultControls;
  delete window.EJS_defaultOptions;
  delete window.EJS_gameID;
  delete window.EJS_ready;
  delete window.EJS_onGameStart;
}

function hideBuiltInTouchControls(): void {
  const emulator = window.EJS_emulator as
    | (typeof window.EJS_emulator & {
        changeSettingOption?: (option: string, value: string, skipSave?: boolean) => void;
        toggleVirtualGamepad?: (show: boolean) => void;
        elements?: {
          menuToggle?: HTMLElement | null;
        };
      })
    | undefined;

  try {
    for (const [option, value] of Object.entries(BUILT_IN_TOUCH_GAMEPAD_OPTIONS)) {
      emulator?.changeSettingOption?.(option, value, true);
    }
    emulator?.toggleVirtualGamepad?.(false);
    if (emulator?.elements?.menuToggle instanceof HTMLElement) {
      emulator.elements.menuToggle.style.display = 'none';
      emulator.elements.menuToggle.style.opacity = '0';
      emulator.elements.menuToggle.style.pointerEvents = 'none';
    }
  } catch {
    // EmulatorJS can reject setting changes before full initialization.
  }

  const touchControlElements = document.querySelectorAll<HTMLElement>('.ejs_virtualGamepad_parent, .ejs_virtualGamepad_open');
  touchControlElements.forEach((element) => {
    element.style.display = 'none';
    element.style.opacity = '0';
    element.style.pointerEvents = 'none';
  });
}

function injectLoaderScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.setAttribute(LOADER_SCRIPT_ATTR, 'true');

    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load EmulatorJS loader from ${src}`));

    document.body.appendChild(script);
  });
}

async function loadWithDataPath(options: {
  dataPath: string;
  core: N64CoreId;
  playerSelector: string;
  romUrl: string;
  gameName: string;
  gameId?: string;
  defaultControls?: EmulatorJsControls;
  onStart?: () => void;
}): Promise<void> {
  clearLoaderScripts();

  window.EJS_player = options.playerSelector;
  window.EJS_gameName = options.gameName;
  window.EJS_biosUrl = '';
  window.EJS_gameUrl = options.romUrl;
  window.EJS_core = options.core;
  window.EJS_pathtodata = options.dataPath;
  window.EJS_startOnLoaded = true;
  window.EJS_DEBUG_XX = true;
  window.EJS_disableDatabases = false;
  window.EJS_threads = false;
  window.EJS_defaultControls = options.defaultControls;
  window.EJS_defaultOptions = {
    ...BUILT_IN_TOUCH_GAMEPAD_OPTIONS,
    retroarch_core: options.core,
  };
  window.EJS_gameID = options.gameId;

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Timed out waiting for EmulatorJS to initialize.'));
    }, 30_000);

    window.EJS_ready = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });

  let startTimeout: number | undefined;
  let failurePoll: number | undefined;
  let didStart = false;

  const startPromise = new Promise<void>((resolve, reject) => {
    startTimeout = window.setTimeout(() => {
      reject(new Error('Timed out waiting for the ROM to start.'));
    }, 45_000);

    failurePoll = window.setInterval(() => {
      if (window.EJS_emulator?.failedToStart) {
        window.clearInterval(failurePoll);
        window.clearTimeout(startTimeout);

        const errorElem = document.querySelector('.ejs_error_text');
        const errorText =
          errorElem instanceof HTMLElement && errorElem.innerText.trim().length > 0
            ? errorElem.innerText.trim()
            : 'EmulatorJS reported a startup failure.';

        reject(new Error(errorText));
      }
    }, 250);

    window.EJS_onGameStart = () => {
      didStart = true;
      window.clearInterval(failurePoll);
      window.clearTimeout(startTimeout);
      hideBuiltInTouchControls();
      window.setTimeout(() => hideBuiltInTouchControls(), 180);
      options.onStart?.();
      resolve();
    };
  });

  try {
    await injectLoaderScript(loaderUrl(options.dataPath));
    await readyPromise;
    await startPromise;
  } finally {
    if (!didStart) {
      if (failurePoll !== undefined) {
        window.clearInterval(failurePoll);
      }
      if (startTimeout !== undefined) {
        window.clearTimeout(startTimeout);
      }
    }
  }
}

export async function startEmulatorJs(options: {
  playerSelector: string;
  romUrl: string;
  gameName: string;
  gameId?: string;
  mode?: EmulatorBootMode;
  defaultControls?: EmulatorJsControls;
  onStart?: () => void;
}): Promise<{ dataPath: string; source: EmulatorDataSource; core: EmulatorCoreId }> {
  const attempts: Array<{ dataPath: string; source: EmulatorDataSource; core: EmulatorCoreId; error: unknown }> = [];
  const mode = options.mode ?? 'auto';

  for (const source of orderedSourcesForMode(mode)) {
    const dataPath = dataPathForSource(source);
    for (const core of N64_CORE_CANDIDATES) {
      try {
        await loadWithDataPath({
          ...options,
          dataPath,
          core,
        });

        return { dataPath, source, core };
      } catch (error) {
        attempts.push({ dataPath, source, core, error });
        stopEmulatorJs(options.playerSelector);
      }
    }
  }

  const reason = attempts
    .map((attempt) => {
      const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
      return `${attempt.source}/${attempt.core} (${attempt.dataPath}): ${message}`;
    })
    .join(' | ');

  throw new Error(`Unable to start EmulatorJS. ${reason}`);
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }

    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

export async function clearEmulatorJsIndexedCaches(): Promise<void> {
  await Promise.all([
    deleteIndexedDb('EmulatorJS-roms'),
    deleteIndexedDb('EmulatorJS-bios'),
    deleteIndexedDb('EmulatorJS-core'),
    deleteIndexedDb('EmulatorJS-states'),
  ]);
}

export function stopEmulatorJs(playerSelector: string): void {
  try {
    window.EJS_emulator?.pause?.(true);
    window.EJS_emulator?.gameManager?.saveSaveFiles?.();
  } catch {
    // Best-effort cleanup.
  }

  const player = document.querySelector(playerSelector);
  if (player instanceof HTMLElement) {
    player.innerHTML = '';
  }

  clearLoaderScripts();
  clearEmulatorGlobals();
  delete window.EJS_emulator;
}
