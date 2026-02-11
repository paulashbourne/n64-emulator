import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { N64ControlTarget } from '../types/input';

interface VirtualControllerProps {
  disabled?: boolean;
  onControlChange: (control: N64ControlTarget, pressed: boolean) => void;
}

export function VirtualController({ disabled = false, onControlChange }: VirtualControllerProps) {
  const activeControlsRef = useRef<Set<N64ControlTarget>>(new Set());
  const [activeControls, setActiveControls] = useState<Set<N64ControlTarget>>(new Set());

  const pressControl = (control: N64ControlTarget): void => {
    if (disabled || activeControlsRef.current.has(control)) {
      return;
    }

    activeControlsRef.current.add(control);
    setActiveControls(new Set(activeControlsRef.current));
    onControlChange(control, true);
  };

  const releaseControl = (control: N64ControlTarget): void => {
    if (!activeControlsRef.current.has(control)) {
      return;
    }

    activeControlsRef.current.delete(control);
    setActiveControls(new Set(activeControlsRef.current));
    onControlChange(control, false);
  };

  const bindControl = (control: N64ControlTarget) => {
    return {
      className: `vc-button ${activeControls.has(control) ? 'active' : ''}`,
      disabled,
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressControl(control);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        releaseControl(control);
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        releaseControl(control);
      },
      onPointerLeave: () => {
        releaseControl(control);
      },
    };
  };

  return (
    <section className="virtual-controller" aria-label="Virtual controller">
      <div className="vc-shoulders">
        <button type="button" {...bindControl('l')}>
          L
        </button>
        <button type="button" {...bindControl('z')}>
          Z
        </button>
        <button type="button" {...bindControl('r')}>
          R
        </button>
      </div>

      <div className="vc-main">
        <div className="vc-cluster vc-dpad">
          <button type="button" {...bindControl('dpad_up')}>
            Up
          </button>
          <div className="vc-row">
            <button type="button" {...bindControl('dpad_left')}>
              Left
            </button>
            <button type="button" {...bindControl('dpad_right')}>
              Right
            </button>
          </div>
          <button type="button" {...bindControl('dpad_down')}>
            Down
          </button>
        </div>

        <div className="vc-cluster vc-analog">
          <button type="button" {...bindControl('analog_up')}>
            Stick Up
          </button>
          <div className="vc-row">
            <button type="button" {...bindControl('analog_left')}>
              Stick Left
            </button>
            <button type="button" {...bindControl('analog_right')}>
              Stick Right
            </button>
          </div>
          <button type="button" {...bindControl('analog_down')}>
            Stick Down
          </button>
        </div>

        <div className="vc-cluster vc-cbuttons">
          <button type="button" {...bindControl('c_up')}>
            C-Up
          </button>
          <div className="vc-row">
            <button type="button" {...bindControl('c_left')}>
              C-Left
            </button>
            <button type="button" {...bindControl('c_right')}>
              C-Right
            </button>
          </div>
          <button type="button" {...bindControl('c_down')}>
            C-Down
          </button>
        </div>

        <div className="vc-cluster vc-actions">
          <button type="button" {...bindControl('a')}>
            A
          </button>
          <button type="button" {...bindControl('b')}>
            B
          </button>
          <button type="button" {...bindControl('start')}>
            Start
          </button>
        </div>
      </div>
    </section>
  );
}
