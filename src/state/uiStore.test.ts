import { beforeEach, describe, expect, test } from 'vitest';

import { useUiStore } from './uiStore';

function resetUiStore(): void {
  useUiStore.setState({
    toasts: [],
    taskBanners: [],
  });
}

describe('uiStore', () => {
  beforeEach(() => {
    resetUiStore();
  });

  test('dedupes toast updates by key', () => {
    const firstId = useUiStore.getState().addToast({
      tone: 'info',
      message: 'Loading session…',
      dedupeKey: 'session:loading',
    });

    const secondId = useUiStore.getState().addToast({
      tone: 'success',
      message: 'Session ready.',
      dedupeKey: 'session:loading',
    });

    const toasts = useUiStore.getState().toasts;
    expect(firstId).not.toEqual(secondId);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe('Session ready.');
    expect(toasts[0]?.tone).toBe('success');
  });

  test('limits toast queue to four items and keeps newest first', () => {
    for (let index = 0; index < 6; index += 1) {
      useUiStore.getState().addToast({
        tone: 'info',
        message: `Toast ${index}`,
      });
    }

    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(4);
    expect(toasts[0]?.message).toBe('Toast 5');
    expect(toasts[3]?.message).toBe('Toast 2');
  });

  test('upserts and clears task banners', () => {
    useUiStore.getState().upsertTaskBanner({
      id: 'import',
      tone: 'info',
      message: 'Importing files',
      detail: '2/10 complete',
      dismissible: false,
    });
    useUiStore.getState().upsertTaskBanner({
      id: 'import',
      tone: 'warning',
      message: 'Import delayed',
      detail: 'Waiting for filesystem response',
    });

    let banners = useUiStore.getState().taskBanners;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.tone).toBe('warning');
    expect(banners[0]?.message).toBe('Import delayed');

    useUiStore.getState().clearTaskBanner('import');
    banners = useUiStore.getState().taskBanners;
    expect(banners).toHaveLength(0);
  });
});
