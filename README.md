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
- Online session MVP: host/join via invite code with up to 4 player slots and live remote input relay into player 2-4
- Session-aware host flow: choose ROM later in Library while preserving active online session context
- Invite UX upgrades: copy invite code or full join link, plus deep-link join prefill (`/online?code=...`)
- Joiner input upgrades: keyboard hold/release capture + gamepad button capture with transition-based relay
- In-room chat with recent message history retained in session snapshots
- WebSocket heartbeat (`ping`/`pong`) from host and joiners for better long-session stability
- Host moderation: explicit “End Session” control that disconnects room members with a clear reason

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

For online multiplayer flows in local development, run the coordinator server too (second terminal):

```bash
npm run dev:multiplayer
```

## Scripts

- `npm run dev` - start development server
- `npm run dev:multiplayer` - start multiplayer coordinator server on `127.0.0.1:8787`
- `npm run build` - type-check and create production build
- `npm run test` - run Vitest in watch mode
- `npm run test:run` - run tests once
- `npm run test:e2e` - run Playwright smoke tests (fast synthetic ROM fixtures)
- `npm run coverage` - run tests with coverage output
- `npm run sync:emulatorjs` - refresh local EmulatorJS runtime/core assets

## E2E smoke test

All remaining e2e tests are fast and use synthetic ROM buffers (no local ROM directory required):

```bash
npm run test:e2e
```

Available focused smoke tests:

```bash
npm run test:e2e -- e2e/invalid-rom-import.smoke.spec.ts
npm run test:e2e -- e2e/mixed-import-feedback.smoke.spec.ts
npm run test:e2e -- e2e/library-size-sort.smoke.spec.ts
npm run test:e2e -- e2e/library-favorites.smoke.spec.ts
npm run test:e2e -- e2e/library-sort-preference.smoke.spec.ts
npm run test:e2e -- e2e/duplicate-import.smoke.spec.ts
npm run test:e2e -- e2e/online-session.smoke.spec.ts
npm run test:e2e -- e2e/online-chat.smoke.spec.ts
npm run test:e2e -- e2e/online-session-end.smoke.spec.ts
```

## Online multiplayer architecture (MVP)

- Decision: central coordinator + host-authoritative game runtime.
- Host creates a session and shares a 6-character invite code.
- Joiners claim the first open slot (`Player 2` through `Player 4`).
- Coordinator tracks room membership and relays remote controller input messages to host.
- Host Play page consumes relayed remote inputs using EmulatorJS `simulateInput` and maps slots to controller ports.
- Joiners can send controller events from on-screen quick inputs, keyboard press/release mapping, or supported gamepad buttons.
- Any connected player can send room chat messages to all other members.
- Host can end a session immediately for all connected clients.

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
- End-to-end online host/join invite-code flow with two browser clients
- End-to-end online room chat between host and joiner
- End-to-end host-initiated session close notification for joiners
- End-to-end host choose-later flow that carries session params from Online room to Library and Play
- Save keying by ROM hash
- Catalog import/index flows
