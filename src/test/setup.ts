import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [],
    },
    writable: true,
    configurable: true,
  });
}

if (typeof navigator.getGamepads !== 'function') {
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => [],
    writable: true,
    configurable: true,
  });
}

if (typeof File !== 'undefined' && typeof File.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    value: function arrayBuffer(): Promise<ArrayBuffer> {
      if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer === 'function') {
        return Blob.prototype.arrayBuffer.call(this as Blob);
      }
      return Promise.resolve(new Uint8Array().buffer);
    },
    writable: true,
    configurable: true,
  });
}
