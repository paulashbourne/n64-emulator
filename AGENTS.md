# Warpdeck 64 Agent Handoff

Last updated: 2026-02-13

This file is a high-context handoff for future agents working in `/Users/paul/git/paulashbourne/n64-emulator`.

## 1) Product Snapshot

Warpdeck 64 is a browser N64 emulator with:

- Local ROM library and cover-art matching
- Local play (EmulatorJS runtime)
- Online multiplayer sessions (host-authoritative)
- Host stream to guests + guest input relay to host
- Controller profile wizard and profile management
- Save slots with console-like default flow + optional advanced mode

Current priority reality:

- Keep online streaming stable and simple
- Avoid overloading UI with too many controls
- Preserve low-latency feel and clean layouts on desktop + tablet + phone

## 2) Repository Map

- Frontend app: `/Users/paul/git/paulashbourne/n64-emulator/src`
- Multiplayer coordinator server: `/Users/paul/git/paulashbourne/n64-emulator/server/multiplayerServer.mjs`
- Deploy scripts: `/Users/paul/git/paulashbourne/n64-emulator/scripts`
- Public emulator assets: `/Users/paul/git/paulashbourne/n64-emulator/public/emulatorjs/data`
- E2E tests: `/Users/paul/git/paulashbourne/n64-emulator/e2e`

Key frontend areas:

- Library page: `src/pages/LibraryPage.tsx`
- Play page: `src/pages/PlayPage.tsx`
- Online landing: `src/pages/OnlinePage.tsx`
- Online session room: `src/pages/OnlineSessionPage.tsx`
- Settings page: `src/pages/SettingsPage.tsx`
- Global store: `src/state/appStore.ts`
- Multiplayer client API: `src/online/multiplayerApi.ts`

## 3) Tech Stack

- React 19 + TypeScript + Vite
- Zustand for app/session state
- Dexie (IndexedDB) for local persistence
- EmulatorJS for N64 runtime
- Node + `ws` for multiplayer coordinator
- Playwright + Vitest for testing

Node expectation:

- Tooling and modern deps target Node 20+
- Running deploy/build scripts on Node 18 may still work but emits engine warnings

## 4) Architecture (Current)

### 4.1 Local Emulator Runtime

- EmulatorJS assets are synced into `public/emulatorjs/data`
- Primary core path uses `parallel_n64` with fallback options
- Play page supports pause/reset/fullscreen, menu overlay, virtual controller, profile management, save controls

### 4.2 Multiplayer Model

- Central coordinator server (not full server-side emulation)
- Host runs emulator locally
- Guests receive host media stream and send controller inputs to host
- Invite-code room model, up to 4 players
- WebSocket endpoint for realtime room signaling and input/chat events

### 4.3 Stream + Input

- Signaling/room events through coordinator
- Host publishes stream
- Guests render stream and relay input
- Host applies remote inputs to controller slots 2-4

## 5) Production Hosting (Current)

Infra repo:

- `/Users/paul/git/paulashbourne/infra/services/n64`

Deployed topology:

- CloudFront + S3 static frontend
- EC2 `t4g.nano` coordinator backend
- Same-origin routing:
  - `/*` static frontend
  - `/api/*` coordinator
  - `/ws/*` coordinator

Current site endpoint (domain transfer-safe mode):

- `https://d105wxhpzpd7sz.cloudfront.net`

### 5.1 Auth Gate (Important)

- Basic auth is enabled at CloudFront edge
- Config is password-only (empty username)
- Successful auth sets a long-lived secure cookie so users are not repeatedly prompted on same browser/device
- Keep secret values in infra tfvars/state, not app source

## 6) Controller Profiles (Most Recent Major Change)

### 6.1 Goal Implemented

All controller mappings are now shared globally across clients by persisting on the coordinator server.

### 6.2 API Endpoints

In `server/multiplayerServer.mjs`:

- `GET /api/controller-profiles`
- `PUT /api/controller-profiles`
- `DELETE /api/controller-profiles/:profileId`

Frontend client wrappers in `src/online/multiplayerApi.ts`:

- `listSharedControllerProfiles()`
- `upsertSharedControllerProfiles(profiles)`
- `deleteSharedControllerProfile(profileId)`

### 6.3 Persistence

Coordinator writes profiles to JSON file:

- env: `MULTIPLAYER_PROFILE_STORE_PATH`
- default: `./.runtime/controller-profiles.json`

On EC2 service, working directory is `/opt/n64-coordinator`, so effective default is:

- `/opt/n64-coordinator/.runtime/controller-profiles.json`

Load behavior:

- Profiles load from disk on coordinator boot
- Updates write through to disk using queued writes

### 6.4 Frontend Sync Behavior

In `src/state/appStore.ts`:

- Profiles are normalized to global scope (`romHash` cleared)
- Local store migrates scoped profiles -> global
- Load flow:
  - ensure defaults exist locally
  - fetch server profiles
  - upload newer local profiles if needed (`updatedAt` conflict rule)
  - merge server set back to local Dexie cache
- Save/delete flow updates local first, then attempts server sync

Conflict strategy:

- Last-write-wins using `updatedAt` timestamps per `profileId`

### 6.5 Precreated Defaults

The app seeds and expects these baseline IDs:

- `profile:keyboard-default`
- `profile:gamepad-switch`
- `profile:gamepad-xbox-series`
- `profile:gamepad-backbone`
- `profile:gamepad-8bitdo-64`

These are pre-seeded in production shared store so first-time clients can use them immediately.

## 7) Save System (Current)

- Save identity is game-oriented, not raw ROM path, using cover/title normalization logic in `src/emulator/saveSlots.ts`
- Default flow is console-like autosave/resume with a primary save slot
- Advanced multi-slot mode can be enabled from settings (expert-oriented)
- Library surfaces save readiness and supports resetting/deleting saves per game

## 8) Deployment Workflow

### 8.1 Frontend Deploy

Script:

- `/Users/paul/git/paulashbourne/n64-emulator/scripts/deploy-frontend.sh`

What it does:

- install deps
- build app
- sync to frontend S3 bucket
- cache-header handling
- CloudFront invalidation

### 8.2 Backend Deploy

Scripts:

- `/Users/paul/git/paulashbourne/n64-emulator/scripts/build-backend-artifact.sh`
- `/Users/paul/git/paulashbourne/n64-emulator/scripts/deploy-backend.sh`

What it does:

- package `server/multiplayerServer.mjs` + prod deps
- upload artifact to artifact bucket
- run SSM command on EC2
- deploy script restarts `n64-coordinator` systemd service

## 9) Local Development Quickstart

```bash
cd /Users/paul/git/paulashbourne/n64-emulator
npm install
npm run dev
```

In a second terminal for multiplayer:

```bash
cd /Users/paul/git/paulashbourne/n64-emulator
npm run dev:multiplayer
```

Optional custom profile-store file locally:

```bash
MULTIPLAYER_PROFILE_STORE_PATH=/tmp/controller-profiles.json npm run dev:multiplayer
```

## 10) Verification Checklist

### 10.1 Fast checks

```bash
npm run typecheck
npm run lint
npm run test:run
```

Focused profile tests:

```bash
npx vitest run src/state/appStore.test.ts src/input/inputService.test.ts
```

### 10.2 Manual product checks

- Create/join online room in two browser contexts
- Start host stream and confirm guest playback remains stable
- Guest input affects host game
- Edit a controller profile on client A, refresh client B, confirm profile update appears
- Reboot coordinator and confirm shared profiles remain available

## 11) Operations / Troubleshooting

### 11.1 Health

- Coordinator health: `/health`
- Through CloudFront: `https://<site>/api/...` and `wss://<site>/ws/...`

### 11.2 Profile sync debugging

- Check API directly:
  - `GET /api/controller-profiles`
  - `PUT /api/controller-profiles`
  - `DELETE /api/controller-profiles/:id`
- Confirm coordinator file exists and updates:
  - `/opt/n64-coordinator/.runtime/controller-profiles.json`

### 11.3 Stream instability

If guests report flashing/reconnect churn:

- Confirm WebSocket remains connected (no tight reconnect loop)
- Check coordinator logs and browser console for repeated bootstrap/re-sync loops
- Validate host stream negotiation path before adding new UX controls
- Keep default UI minimal; gate advanced controls behind explicit expansion

## 12) UX / Product Principles (Current Direction)

- Prefer fewer controls by default, with advanced actions hidden
- Keep host and guest views visually consistent where practical
- Maximize game viewport in local play
- Keep mobile touch/controller flows usable without overwhelming desktop users

## 13) Known Constraints

- No account system yet (access currently gated via edge basic auth)
- Shared controller profiles are intentionally global for now (single shared namespace)
- Profile persistence is file-backed on one coordinator instance (simple by design)
- ROM binaries and save data remain client-local (IndexedDB), not server-synced

## 14) Near-Term Follow-ups

- If requested, export collected shared profile JSON from coordinator and bake calibrated defaults into app code
- Add profile versioning/import-export UX once calibration stabilizes
- Consider moving shared profile persistence from JSON file to managed DB only if multi-instance scaling becomes necessary

