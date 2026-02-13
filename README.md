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
- Built-in N64 box art inventory (540 titles) with automatic ROM title matching in Library and Resume cards
- Library sorting supports title, last played, and size
- Favorites workflow (favorite/unfavorite, favorites-only filter, favorites-first sort)
- Library view preferences persist (sort mode and favorites-only filter)
- One-click controller keyboard preset in the mapping wizard
- Keyboard shortcuts on play screen: `Space` pause/resume, `R` reset, `M` open mapper, `O` menu, `H` HUD, `Y` host stabilize viewers, `Esc` close overlays
- Immersive play HUD controls: instant hide/show (`H`) and optional auto-hide while running
- Online session MVP: host/join via invite code with up to 4 player slots and live remote input relay into player 2-4
- Session-aware host flow: choose ROM later in Library while preserving active online session context
- Invite UX upgrades: copy invite code or full join link, plus deep-link join prefill (`/online?code=...`)
- Joiner input upgrades: keyboard hold/release capture + gamepad button capture with transition-based relay
- In-room chat with recent message history retained in session snapshots
- WebSocket heartbeat (`ping`/`pong`) from host and joiners for better long-session stability
- Lightweight per-member latency update events (`member_latency`) to avoid full room-state churn
- Host moderation: explicit “End Session” control that disconnects room members with a clear reason
- In-room host ROM picker: set/clear room ROM directly from session page (no navigation required)
- Host moderation: kick specific players from room without ending the whole session
- Host slot management: move guests into open slots or swap occupied player slots live
- Recent Sessions on Online page with one-click reopen and persisted local history
- Guest stream quality hints: guests can request host stream mode changes in-session
- Host input moderation: mute or unmute individual guest controller input live
  - Room-synced mute state across reconnects/session views with host blocked-input telemetry
- Online session lobby moderation: host can mute/unmute all guest inputs with one action
- Per-player relay latency telemetry for host and guests in online session/player controls
- Guest input relay modes (Auto/Responsive/Balanced/Conservative) with persisted session view preferences
- Guest quick input deck supports both tap and hold actions for cleaner touch/controller hybrid play
- Guest can auto-request host stream quality mode on sustained degraded network (toggleable)
- Guest playback watchdog can auto-recover frozen stream playback (toggleable)
- Host play menu now shows per-viewer stream diagnostics (health, RTT, FPS, bitrate)
- Host viewer-pressure panel highlights degraded links with one-click and optional auto stabilization
- Host can manually re-sync an individual viewer stream and auto-heal poor viewer links
- Guest “Latency Rescue” action instantly switches to low-latency controls and requests host stream rescue

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

Optional for production multiplayer reliability, configure custom ICE servers (including TURN) in `.env`:

```bash
VITE_MULTIPLAYER_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":"turn:turn.example.com:3478","username":"demo","credential":"secret"}]'
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
- `npm run sync:covers` - rebuild `src/roms/n64CoverInventory.ts` from libretro cover metadata

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
npm run test:e2e -- e2e/online-session-input-mute.smoke.spec.ts
npm run test:e2e -- e2e/online-session-bulk-mute.smoke.spec.ts
npm run test:e2e -- e2e/online-room-rom-picker.smoke.spec.ts
npm run test:e2e -- e2e/online-kick-member.smoke.spec.ts
npm run test:e2e -- e2e/online-recent-sessions.smoke.spec.ts
npm run test:e2e -- e2e/online-player-relay-latency.smoke.spec.ts
npm run test:e2e -- e2e/online-slot-reassign.smoke.spec.ts
npm run test:e2e -- e2e/online-slot-swap.smoke.spec.ts
npm run test:e2e -- e2e/online-stream-quality-hint.smoke.spec.ts
npm run test:e2e -- e2e/online-input-moderation.smoke.spec.ts
npm run test:e2e -- e2e/online-guest-relay-mode.smoke.spec.ts
npm run test:e2e -- e2e/online-host-viewer-telemetry.smoke.spec.ts
npm run test:e2e -- e2e/online-latency-rescue.smoke.spec.ts
npm run test:e2e -- e2e/play-hud-immersive.smoke.spec.ts
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
- Host can assign or clear the room ROM directly in the session UI.
- Host can remove an individual member while keeping the room alive.
- Users can quickly reopen recently used sessions from the Online landing page.

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
- End-to-end host room-ROM picker flow shared to joiners
- End-to-end host kick-member flow with kicked-client notification
- End-to-end recent-session persistence and reopen flow
- End-to-end host choose-later flow that carries session params from Online room to Library and Play
- Save keying by ROM hash
- Catalog import/index flows
