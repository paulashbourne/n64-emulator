import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { VirtualController } from './VirtualController';

function mockRect(element: HTMLElement, width = 200, height = 200): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  });
}

describe('VirtualController', () => {
  test('emits analog stick movement and resets to neutral on release', () => {
    const onControlChange = vi.fn();
    const onAnalogChange = vi.fn();

    render(
      <VirtualController
        onControlChange={onControlChange}
        onAnalogChange={onAnalogChange}
      />,
    );

    const pad = screen.getByLabelText('Analog stick pad');
    Object.defineProperty(pad, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    mockRect(pad);

    fireEvent.pointerDown(pad, {
      pointerId: 1,
      clientX: 160,
      clientY: 100,
    });

    expect(onAnalogChange).toHaveBeenCalled();
    const movementCall = onAnalogChange.mock.calls.at(-1);
    expect(movementCall?.[0]).toBeGreaterThan(0);

    fireEvent.pointerUp(pad, {
      pointerId: 1,
      clientX: 160,
      clientY: 100,
    });

    expect(onAnalogChange).toHaveBeenLastCalledWith(0, 0);
    expect(onControlChange).not.toHaveBeenCalled();
  });

  test('renders C-buttons in compact mode and emits digital press/release', () => {
    const onControlChange = vi.fn();

    render(<VirtualController mode="compact" onControlChange={onControlChange} />);

    const cUp = screen.getByRole('button', { name: 'C-Up' });
    Object.defineProperty(cUp, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(cUp, { pointerId: 7 });
    fireEvent.pointerUp(cUp, { pointerId: 7 });

    expect(onControlChange).toHaveBeenNthCalledWith(1, 'c_up', true);
    expect(onControlChange).toHaveBeenNthCalledWith(2, 'c_up', false);
  });

  test('continues to emit button input when pointer capture is unavailable', () => {
    const onControlChange = vi.fn();
    render(<VirtualController mode="compact" onControlChange={onControlChange} />);

    const aButton = screen.getByRole('button', { name: 'A' });
    Object.defineProperty(aButton, 'setPointerCapture', {
      configurable: true,
      value: () => {
        throw new Error('capture unavailable');
      },
    });

    fireEvent.pointerDown(aButton, { pointerId: 10 });
    fireEvent.pointerUp(aButton, { pointerId: 10 });

    expect(onControlChange).toHaveBeenNthCalledWith(1, 'a', true);
    expect(onControlChange).toHaveBeenNthCalledWith(2, 'a', false);
  });

  test('releases held controls when controller becomes disabled', () => {
    vi.useFakeTimers();
    const onControlChange = vi.fn();
    const { rerender } = render(<VirtualController mode="compact" onControlChange={onControlChange} disabled={false} />);

    const zButton = screen.getByRole('button', { name: 'Z' });
    Object.defineProperty(zButton, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(zButton, { pointerId: 12 });
    expect(onControlChange).toHaveBeenCalledWith('z', true);

    rerender(<VirtualController mode="compact" onControlChange={onControlChange} disabled />);
    act(() => {
      vi.runAllTimers();
    });

    expect(onControlChange).toHaveBeenCalledWith('z', false);
    vi.useRealTimers();
  });

  test('releases held controls and analog state when unmounted', () => {
    const onControlChange = vi.fn();
    const onAnalogChange = vi.fn();
    const { unmount } = render(
      <VirtualController mode="compact" onControlChange={onControlChange} onAnalogChange={onAnalogChange} />,
    );

    const bButton = screen.getByRole('button', { name: 'B' });
    Object.defineProperty(bButton, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(bButton, { pointerId: 20 });

    const pad = screen.getByLabelText('Analog stick pad');
    Object.defineProperty(pad, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    mockRect(pad);
    fireEvent.pointerDown(pad, {
      pointerId: 21,
      clientX: 164,
      clientY: 100,
    });
    expect(onAnalogChange).toHaveBeenCalled();

    unmount();

    expect(onControlChange).toHaveBeenCalledWith('b', false);
    expect(onAnalogChange).toHaveBeenLastCalledWith(0, 0);
  });
});
