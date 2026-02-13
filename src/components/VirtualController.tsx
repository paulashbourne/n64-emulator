import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { N64ControlTarget } from '../types/input';

interface VirtualControllerProps {
  disabled?: boolean;
  mode?: 'full' | 'compact';
  onControlChange: (control: N64ControlTarget, pressed: boolean) => void;
  onAnalogChange?: (x: number, y: number) => void;
}

interface StickVector {
  x: number;
  y: number;
}

const STICK_MAX_RADIUS_RATIO = 0.72;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeStickValue(value: number): number {
  if (Math.abs(value) < 0.01) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

export function VirtualController({
  disabled = false,
  mode = 'full',
  onControlChange,
  onAnalogChange,
}: VirtualControllerProps) {
  const onControlChangeRef = useRef(onControlChange);
  const onAnalogChangeRef = useRef(onAnalogChange);
  const activeControlsRef = useRef<Set<N64ControlTarget>>(new Set());
  const activeStickPointerRef = useRef<number | null>(null);
  const stickVectorRef = useRef<StickVector>({ x: 0, y: 0 });
  const stickPadRef = useRef<HTMLDivElement | null>(null);

  const [activeControls, setActiveControls] = useState<Set<N64ControlTarget>>(new Set());
  const [stickVector, setStickVector] = useState<StickVector>({ x: 0, y: 0 });

  useEffect(() => {
    onControlChangeRef.current = onControlChange;
    onAnalogChangeRef.current = onAnalogChange;
  }, [onControlChange, onAnalogChange]);

  const safeSetPointerCapture = (
    target: EventTarget & { setPointerCapture?: (pointerId: number) => void },
    pointerId: number,
  ): void => {
    if (typeof target.setPointerCapture !== 'function') {
      return;
    }
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some WebKit builds can throw when pointer capture is unavailable.
    }
  };

  const pressControl = (control: N64ControlTarget): void => {
    if (disabled || activeControlsRef.current.has(control)) {
      return;
    }

    activeControlsRef.current.add(control);
    setActiveControls(new Set(activeControlsRef.current));
    onControlChangeRef.current(control, true);
  };

  const releaseControl = (control: N64ControlTarget): void => {
    if (!activeControlsRef.current.has(control)) {
      return;
    }

    activeControlsRef.current.delete(control);
    setActiveControls(new Set(activeControlsRef.current));
    onControlChangeRef.current(control, false);
  };

  const setStickVectorFromInput = (x: number, y: number): void => {
    const normalizedX = normalizeStickValue(clamp(x, -1, 1));
    const normalizedY = normalizeStickValue(clamp(y, -1, 1));
    stickVectorRef.current = { x: normalizedX, y: normalizedY };
    setStickVector({ x: normalizedX, y: normalizedY });
    onAnalogChangeRef.current?.(normalizedX, normalizedY);
  };

  const releaseStick = (): void => {
    activeStickPointerRef.current = null;
    setStickVectorFromInput(0, 0);
  };

  useEffect(() => {
    if (disabled) {
      const releaseTimer = window.setTimeout(() => {
        if (activeControlsRef.current.size > 0) {
          const controls = Array.from(activeControlsRef.current.values());
          activeControlsRef.current.clear();
          setActiveControls(new Set());
          for (const control of controls) {
            onControlChangeRef.current(control, false);
          }
        }

        if (activeStickPointerRef.current !== null || stickVectorRef.current.x !== 0 || stickVectorRef.current.y !== 0) {
          activeStickPointerRef.current = null;
          setStickVectorFromInput(0, 0);
        }
      }, 0);
      return () => {
        window.clearTimeout(releaseTimer);
      };
    }
    return undefined;
  }, [disabled]);

  useEffect(() => {
    const controlsRef = activeControlsRef;
    const stickPointerRef = activeStickPointerRef;
    const stickStateRef = stickVectorRef;
    const controlHandlerRef = onControlChangeRef;
    const analogHandlerRef = onAnalogChangeRef;
    return () => {
      if (controlsRef.current.size > 0) {
        const controls = Array.from(controlsRef.current.values());
        controlsRef.current.clear();
        for (const control of controls) {
          controlHandlerRef.current(control, false);
        }
      }

      if (stickPointerRef.current !== null || stickStateRef.current.x !== 0 || stickStateRef.current.y !== 0) {
        stickPointerRef.current = null;
        stickStateRef.current = { x: 0, y: 0 };
        analogHandlerRef.current?.(0, 0);
      }
    };
  }, [activeControlsRef, activeStickPointerRef, onAnalogChangeRef, onControlChangeRef, stickVectorRef]);

  const updateStickFromPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pad = stickPadRef.current;
    if (!pad) {
      return;
    }

    const rect = pad.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const rawX = event.clientX - centerX;
    const rawY = event.clientY - centerY;

    const maxRadius = Math.max(1, (Math.min(rect.width, rect.height) / 2) * STICK_MAX_RADIUS_RATIO);
    const distance = Math.hypot(rawX, rawY);
    const scale = distance > maxRadius ? maxRadius / distance : 1;

    const constrainedX = rawX * scale;
    const constrainedY = rawY * scale;

    // N64 y-axis is positive upward.
    setStickVectorFromInput(constrainedX / maxRadius, -constrainedY / maxRadius);
  };

  const bindControl = (control: N64ControlTarget, className?: string, ariaLabel?: string) => {
    return {
      className: `vc-button ${className ?? ''} ${activeControls.has(control) ? 'active' : ''}`.trim(),
      'aria-label': ariaLabel,
      disabled,
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        safeSetPointerCapture(event.currentTarget, event.pointerId);
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
    <section className={`virtual-controller ${mode === 'compact' ? 'compact' : ''}`} aria-label="Virtual controller">
      <div className="vc-shoulders">
        <button type="button" {...bindControl('l', 'vc-shoulder vc-shoulder-l')}>
          L
        </button>
        <button type="button" {...bindControl('z', 'vc-shoulder vc-shoulder-z')}>
          Z
        </button>
        <button type="button" {...bindControl('r', 'vc-shoulder vc-shoulder-r')}>
          R
        </button>
      </div>

      <div className="vc-main">
        <div className="vc-left-column">
          <div className="vc-dpad-cluster" aria-label="D-pad">
            <button type="button" {...bindControl('dpad_up', 'vc-dpad-button vc-dpad-up', 'D-Pad Up')}>
              <span aria-hidden="true">↑</span>
            </button>
            <button type="button" {...bindControl('dpad_left', 'vc-dpad-button vc-dpad-left', 'D-Pad Left')}>
              <span aria-hidden="true">←</span>
            </button>
            <button type="button" {...bindControl('dpad_right', 'vc-dpad-button vc-dpad-right', 'D-Pad Right')}>
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" {...bindControl('dpad_down', 'vc-dpad-button vc-dpad-down', 'D-Pad Down')}>
              <span aria-hidden="true">↓</span>
            </button>
          </div>

          <div className="vc-analog-cluster">
            <div
              ref={stickPadRef}
              className={`vc-stick-pad ${stickVector.x !== 0 || stickVector.y !== 0 ? 'active' : ''}`}
              role="application"
              aria-label="Analog stick pad"
              onPointerDown={(event) => {
                if (disabled) {
                  return;
                }
                event.preventDefault();
                activeStickPointerRef.current = event.pointerId;
                safeSetPointerCapture(event.currentTarget, event.pointerId);
                updateStickFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (disabled || activeStickPointerRef.current !== event.pointerId) {
                  return;
                }
                event.preventDefault();
                updateStickFromPointer(event);
              }}
              onPointerUp={(event) => {
                if (activeStickPointerRef.current !== event.pointerId) {
                  return;
                }
                event.preventDefault();
                releaseStick();
              }}
              onPointerCancel={(event) => {
                if (activeStickPointerRef.current !== event.pointerId) {
                  return;
                }
                event.preventDefault();
                releaseStick();
              }}
              onPointerLeave={() => {
                if (activeStickPointerRef.current === null) {
                  return;
                }
                releaseStick();
              }}
            >
              <div className="vc-stick-ring" />
              <div
                className="vc-stick-knob"
                style={{
                  transform: `translate(${stickVector.x * 28}px, ${stickVector.y * -28}px)`,
                }}
              />
            </div>
            {mode === 'full' ? <p className="vc-stick-readout">Stick X {stickVector.x.toFixed(2)} / Y {stickVector.y.toFixed(2)}</p> : null}
          </div>
        </div>

        <div className="vc-center-column">
          <button type="button" {...bindControl('start', 'vc-start-button')}>
            Start
          </button>
        </div>

        <div className="vc-right-column">
          <div className="vc-c-cluster" aria-label="C-buttons">
            <button type="button" {...bindControl('c_up', 'vc-c-button vc-c-up', 'C-Up')}>
              C↑
            </button>
            <button type="button" {...bindControl('c_left', 'vc-c-button vc-c-left', 'C-Left')}>
              C←
            </button>
            <button type="button" {...bindControl('c_right', 'vc-c-button vc-c-right', 'C-Right')}>
              C→
            </button>
            <button type="button" {...bindControl('c_down', 'vc-c-button vc-c-down', 'C-Down')}>
              C↓
            </button>
          </div>

          <div className="vc-face-cluster" aria-label="Face buttons">
            <button type="button" {...bindControl('a', 'vc-face-button vc-face-a')}>
              A
            </button>
            <button type="button" {...bindControl('b', 'vc-face-button vc-face-b')}>
              B
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
