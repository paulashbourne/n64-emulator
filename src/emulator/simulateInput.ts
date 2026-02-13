export type SimulateInputFn = (player: number, input: number, value: number) => void;

export function resolveEmulatorSimulateInput(emulator: EmulatorJsInstance | undefined): SimulateInputFn | null {
  const gameManager = emulator?.gameManager;
  if (!gameManager) {
    return null;
  }

  if (typeof gameManager.simulateInput === 'function') {
    return (player: number, input: number, value: number) => {
      gameManager.simulateInput?.call(gameManager, player, input, value);
    };
  }

  if (typeof gameManager.functions?.simulateInput === 'function') {
    return (player: number, input: number, value: number) => {
      gameManager.functions?.simulateInput?.call(gameManager.functions, player, input, value);
    };
  }

  return null;
}
