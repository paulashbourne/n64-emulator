import { resolveEmulatorSimulateInput } from './simulateInput';

describe('resolveEmulatorSimulateInput', () => {
  test('returns null when emulator hooks are unavailable', () => {
    expect(resolveEmulatorSimulateInput(undefined)).toBeNull();
    expect(resolveEmulatorSimulateInput({})).toBeNull();
  });

  test('calls direct gameManager simulateInput with preserved context', () => {
    const gameManager = {
      calls: [] as Array<[number, number, number]>,
      simulateInput(this: { calls: Array<[number, number, number]> }, player: number, input: number, value: number) {
        this.calls.push([player, input, value]);
      },
    };

    const simulateInput = resolveEmulatorSimulateInput({
      gameManager,
    });

    expect(simulateInput).not.toBeNull();
    simulateInput?.(0, 6, 1);
    expect(gameManager.calls).toEqual([[0, 6, 1]]);
  });

  test('calls nested gameManager.functions simulateInput with preserved context', () => {
    const functions = {
      calls: [] as Array<[number, number, number]>,
      simulateInput(this: { calls: Array<[number, number, number]> }, player: number, input: number, value: number) {
        this.calls.push([player, input, value]);
      },
    };

    const simulateInput = resolveEmulatorSimulateInput({
      gameManager: {
        functions,
      },
    });

    expect(simulateInput).not.toBeNull();
    simulateInput?.(1, 2, 0);
    expect(functions.calls).toEqual([[1, 2, 0]]);
  });
});
