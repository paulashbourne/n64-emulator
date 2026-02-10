# Browser N64 Emulator (Chromium-first MVP)

A browser-based N64 emulator app scaffold with:

- Real N64 runtime via EmulatorJS (`public/emulatorjs/data` + `src/emulator/emulatorJsRuntime.ts`)
- Local ROM cataloging from folder handles (Chromium) and file imports fallback
- Interactive button-by-button controller mapping wizard (gamepad + keyboard)
- IndexedDB persistence for ROM metadata, controller profiles, and save data
- React + TypeScript UI for library, play, and settings flows
- Boot troubleshooting controls (retry auto/local/CDN, clear EmulatorJS cache and retry)
- Library utilities for re-indexing previously authorized folder handles
- Per-ROM removal from the local catalog (without clearing all app data)
- Quick “Resume Last Played” launcher in the library
- Library sorting supports title, last played, and size
- Favorites workflow (favorite/unfavorite, favorites-only filter, favorites-first sort)
- Library view preferences persist (sort mode and favorites-only filter)
- One-click controller keyboard preset in the mapping wizard
- Keyboard shortcuts on play screen: `Space` pause/resume, `R` reset, `M` open mapper, `Esc` close mapper

## Current core status

The Play page now boots ROMs through EmulatorJS with local core assets synced into:

- `public/emulatorjs/data/`
- Bundled N64 cores: `parallel_n64` and `mupen64plus_next`
- Runtime prefers `parallel_n64`, falls back to `mupen64plus_next`, and can switch data source (local/CDN) when needed

Assets are synced from npm packages by:

- `npm run sync:emulatorjs` (also run automatically on `npm install`)

## Requirements

- Node.js 20+

## Quick start

```bash
npm install
npm run dev
```

## Scripts

- `npm run dev` - start development server
- `npm run build` - type-check and create production build
- `npm run test` - run Vitest in watch mode
- `npm run test:run` - run tests once
- `npm run test:e2e` - run Playwright smoke tests (requires ROM path env var)
- `npm run coverage` - run tests with coverage output
- `npm run sync:emulatorjs` - refresh local EmulatorJS runtime/core assets

## E2E smoke test

Run an end-to-end ROM boot smoke test against a local file:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/rom-boot.smoke.spec.ts
```

Controller mapping smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/controller-wizard.smoke.spec.ts
```

Controller keyboard preset smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/controller-keyboard-preset.smoke.spec.ts
```

Boot recovery smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/boot-recovery.smoke.spec.ts
```

Library removal smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/library-remove.smoke.spec.ts
```

Play shortcuts smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/play-shortcuts.smoke.spec.ts
```

Boot mode preference smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/settings-boot-mode.smoke.spec.ts
```

Resume last played smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/resume-last-played.smoke.spec.ts
```

Core fallback smoke test:

```bash
E2E_ROM_PATH="/absolute/path/to/game.z64" npm run test:e2e -- e2e/core-fallback.smoke.spec.ts
```

Invalid ROM import smoke test:

```bash
npm run test:e2e -- e2e/invalid-rom-import.smoke.spec.ts
```

Mixed valid/invalid import feedback smoke test:

```bash
npm run test:e2e -- e2e/mixed-import-feedback.smoke.spec.ts
```

Library sort-by-size smoke test:

```bash
npm run test:e2e -- e2e/library-size-sort.smoke.spec.ts
```

Library favorites smoke test:

```bash
npm run test:e2e -- e2e/library-favorites.smoke.spec.ts
```

Library sort preference persistence smoke test:

```bash
npm run test:e2e -- e2e/library-sort-preference.smoke.spec.ts
```

Duplicate ROM import dedupe smoke test:

```bash
npm run test:e2e -- e2e/duplicate-import.smoke.spec.ts
```

Multi-ROM boot stress smoke test (imports first `N` ROMs from a folder, then boots each sequentially):

```bash
E2E_ROM_DIR="/absolute/path/to/rom-folder" E2E_MULTI_ROM_COUNT=5 npm run test:e2e -- e2e/multi-rom-boot.smoke.spec.ts
```

## Browser support

- Chromium (Chrome/Edge): full folder picker + persistent handle indexing
- Firefox/Safari: file import fallback (no persistent directory handle)

## Data storage

All local state is stored in IndexedDB via Dexie:

- ROM catalog metadata and handles
- Imported ROM binaries
- Controller profiles
- Per-ROM save blobs keyed by ROM hash

## Testing

Included tests cover:

- ROM extension filtering and header parsing
- Hash stability after ROM byte-order normalization
- Mapping wizard state transitions
- Axis threshold/deadzone handling
- Reconnect-safe gamepad profile matching by device id
- Keyboard mapping translation into EmulatorJS control codes
- Favorite persistence and favorites query behavior
- Gamepad capture edge detection when controls start held
- Duplicate ROM import dedupe handling
- Keyboard preset mapping flow in the controller wizard
- Save keying by ROM hash
- Catalog import/index flows
