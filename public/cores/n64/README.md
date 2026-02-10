# N64 Core Artifacts

This folder is where a production WASM N64 core should live.

Expected default path:

- `public/cores/n64/n64core.wasm`

The app currently includes a worker/runtime adapter and a mock rendering fallback. To enable
real emulation, place a compatible N64 WebAssembly core at the path above and update
`/Users/paulashbourne/git/paulashbourne/n64-emulator/src/emulator/coreWorker.ts` with the core-specific API bindings.
