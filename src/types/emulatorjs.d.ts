export {};

declare global {
  interface EmulatorJsGameManagerFunctions {
    simulateInput?: (player: number, index: number, value: number) => void;
  }

  interface EmulatorJsGameManager {
    restart?: () => void;
    saveSaveFiles?: () => void;
    getSaveFile?: (save?: boolean) => Uint8Array | null;
    getSaveFilePath?: () => string;
    loadSaveFiles?: () => void;
    writeFile?: (path: string, data: Uint8Array | ArrayBuffer) => void;
    FS?: {
      analyzePath?: (path: string) => { exists: boolean };
      unlink?: (path: string) => void;
    };
    simulateInput?: (player: number, index: number, value: number) => void;
    functions?: EmulatorJsGameManagerFunctions;
  }

  interface EmulatorJsInstance {
    on?: (eventName: string, callback: () => void) => void;
    pause?: (dontUpdate?: boolean) => void;
    play?: (dontUpdate?: boolean) => void;
    setupKeys?: () => void;
    checkGamepadInputs?: () => void;
    saveSettings?: () => void;
    failedToStart?: boolean;
    controls?: Record<number, Record<number, { value?: number; value2?: string | number }>>;
    gameManager?: EmulatorJsGameManager;
  }

  interface Window {
    EJS_emulator?: EmulatorJsInstance;

    EJS_player?: string;
    EJS_gameName?: string;
    EJS_biosUrl?: string;
    EJS_gameUrl?: string;
    EJS_core?: string;
    EJS_pathtodata?: string;
    EJS_startOnLoaded?: boolean;
    EJS_DEBUG_XX?: boolean;
    EJS_disableDatabases?: boolean;
    EJS_threads?: boolean;
    EJS_defaultControls?: Record<number, Record<number, { value?: number; value2?: string | number }>>;
    EJS_defaultOptions?: Record<string, string | number | boolean>;
    EJS_gameID?: string;

    EJS_ready?: () => void;
    EJS_onGameStart?: () => void;
  }
}
