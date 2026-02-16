import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import {
  applyKeyboardPreset,
  assignBindingAndAdvance,
  createInitialWizardState,
  currentTarget,
  goBack,
  isWizardComplete,
  mappingSummary,
  resetWizard,
  skipCurrentTarget,
  wizardProgress,
  type MappingWizardState,
} from '../input/mappingWizard';
import { bindingToLabel, captureNextInput, controlPrompt, isBindingActive } from '../input/inputService';
import { CONTROL_LABELS, isAnalogTarget, N64_MAPPING_ORDER } from '../types/input';
import type { ControllerProfile, InputBinding, N64ControlTarget } from '../types/input';

type ControllerWizardSaveMode = 'create' | 'edit';

interface ControllerWizardProps {
  romHash?: string;
  initialProfile?: ControllerProfile;
  saveMode?: ControllerWizardSaveMode;
  onCancel: () => void;
  onComplete: (profile: ControllerProfile) => Promise<void>;
}

function resolveDeviceId(state: MappingWizardState, fallback?: string): string {
  for (const binding of Object.values(state.bindings)) {
    if (binding?.deviceId) {
      return binding.deviceId;
    }
  }

  return fallback ?? 'keyboard-generic';
}

export function ControllerWizard({
  romHash,
  initialProfile,
  saveMode,
  onCancel,
  onComplete,
}: ControllerWizardProps) {
  const effectiveSaveMode: ControllerWizardSaveMode = saveMode ?? (initialProfile ? 'edit' : 'create');
  const [wizardState, setWizardState] = useState<MappingWizardState>(
    createInitialWizardState(initialProfile?.bindings),
  );
  const [profileName, setProfileName] = useState(initialProfile?.name ?? 'My Controller Profile');
  const [deadzone, setDeadzone] = useState(initialProfile?.deadzone ?? 0.2);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [singleRemapTarget, setSingleRemapTarget] = useState<N64ControlTarget | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const lastCapturedBindingRef = useRef<InputBinding | undefined>(undefined);
  const captureInFlightRef = useRef(false);
  const heldKeysRef = useRef<Set<string>>(new Set());

  const target = currentTarget(wizardState);
  const complete = isWizardComplete(wizardState);
  const progress = wizardProgress(wizardState);
  const summary = useMemo(() => mappingSummary(wizardState), [wizardState]);

  const readConnectedGamepads = useCallback((): Gamepad[] => {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return [];
    }
    return Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => Boolean(pad));
  }, []);

  const isWaitingForRelease = useCallback(
    (binding: InputBinding): boolean => {
      return isBindingActive(binding, heldKeysRef.current, readConnectedGamepads());
    },
    [readConnectedGamepads],
  );

  const stopCapture = useCallback((): void => {
    if (captureAbortRef.current) {
      captureAbortRef.current.abort();
      captureAbortRef.current = null;
    }
    captureInFlightRef.current = false;
    setIsCapturing(false);
  }, []);

  const onCapture = useCallback(async (): Promise<void> => {
    if (!target || isSaving || isCapturing || captureInFlightRef.current) {
      return;
    }

    captureInFlightRef.current = true;
    setError(undefined);
    setIsCapturing(true);
    const captureController = new AbortController();
    captureAbortRef.current = captureController;

    try {
      const binding = await captureNextInput({
        allowKeyboard: true,
        preferDiscreteAxes: !isAnalogTarget(target),
        signal: captureController.signal,
        waitForReleaseBinding: lastCapturedBindingRef.current,
      });

      if (captureController.signal.aborted) {
        return;
      }

      lastCapturedBindingRef.current = binding;
      const isSingleTargetRemap = singleRemapTarget !== null && target === singleRemapTarget;
      setWizardState((state) => {
        if (!isSingleTargetRemap) {
          return assignBindingAndAdvance(state, binding);
        }

        return {
          ...state,
          bindings: {
            ...state.bindings,
            [target]: binding,
          },
          skippedTargets: state.skippedTargets.filter((entry) => entry !== target),
          stepIndex: N64_MAPPING_ORDER.length,
        };
      });
      if (isSingleTargetRemap) {
        setSingleRemapTarget(null);
      }
    } catch (captureError) {
      if (captureError instanceof Error && captureError.name === 'AbortError') {
        return;
      }
      const message = captureError instanceof Error ? captureError.message : 'Failed to capture input.';
      setError(message);
    } finally {
      captureInFlightRef.current = false;
      if (captureAbortRef.current === captureController) {
        captureAbortRef.current = null;
        setIsCapturing(false);
      }
    }
  }, [isCapturing, isSaving, singleRemapTarget, target]);

  useEffect(() => {
    if (!target || isSaving || isCapturing) {
      return;
    }
    const waitingBinding = lastCapturedBindingRef.current;
    if (!waitingBinding || !isWaitingForRelease(waitingBinding)) {
      void onCapture();
      return;
    }

    let frameHandle: number | null = null;
    let cancelled = false;

    const pollForRelease = (): void => {
      if (cancelled) {
        return;
      }
      if (isWaitingForRelease(waitingBinding)) {
        frameHandle = requestAnimationFrame(pollForRelease);
        return;
      }
      void onCapture();
    };

    frameHandle = requestAnimationFrame(pollForRelease);
    return () => {
      cancelled = true;
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
    };
  }, [isCapturing, isSaving, isWaitingForRelease, onCapture, target]);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent): void => {
      const targetElement = event.target as HTMLElement | null;
      if (
        targetElement &&
        (targetElement.tagName === 'INPUT' ||
          targetElement.tagName === 'TEXTAREA' ||
          targetElement.tagName === 'SELECT' ||
          targetElement.isContentEditable)
      ) {
        return;
      }

      if (event.code === 'Escape') {
        return;
      }

      heldKeysRef.current.add(event.code);
      event.preventDefault();
      event.stopPropagation();
    };

    const onGlobalKeyUp = (event: KeyboardEvent): void => {
      const targetElement = event.target as HTMLElement | null;
      if (
        targetElement &&
        (targetElement.tagName === 'INPUT' ||
          targetElement.tagName === 'TEXTAREA' ||
          targetElement.tagName === 'SELECT' ||
          targetElement.isContentEditable)
      ) {
        return;
      }

      if (event.code === 'Escape') {
        return;
      }

      heldKeysRef.current.delete(event.code);
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', onGlobalKeyDown, true);
    window.addEventListener('keyup', onGlobalKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown, true);
      window.removeEventListener('keyup', onGlobalKeyUp, true);
    };
  }, []);

  useEffect(() => {
    return () => {
      stopCapture();
    };
  }, [stopCapture]);

  const onBack = (): void => {
    setError(undefined);
    stopCapture();
    lastCapturedBindingRef.current = undefined;
    if (singleRemapTarget) {
      setSingleRemapTarget(null);
      setWizardState((state) => ({
        ...state,
        stepIndex: N64_MAPPING_ORDER.length,
      }));
      return;
    }
    setWizardState((state) => goBack(state));
  };

  const onSkip = (): void => {
    setError(undefined);
    stopCapture();
    lastCapturedBindingRef.current = undefined;
    if (singleRemapTarget) {
      setSingleRemapTarget(null);
      setWizardState((state) => ({
        ...state,
        stepIndex: N64_MAPPING_ORDER.length,
      }));
      return;
    }
    setWizardState((state) => skipCurrentTarget(state));
  };

  const onReset = (): void => {
    setError(undefined);
    stopCapture();
    lastCapturedBindingRef.current = undefined;
    setSingleRemapTarget(null);
    setWizardState(resetWizard());
  };

  const onApplyKeyboardPreset = (): void => {
    setError(undefined);
    lastCapturedBindingRef.current = undefined;
    setSingleRemapTarget(null);
    setWizardState(applyKeyboardPreset());
  };

  const onCancelWizard = (): void => {
    stopCapture();
    lastCapturedBindingRef.current = undefined;
    setSingleRemapTarget(null);
    onCancel();
  };

  const onRemapSingleControl = (remapTarget: N64ControlTarget): void => {
    const stepIndex = N64_MAPPING_ORDER.indexOf(remapTarget);
    if (stepIndex === -1) {
      return;
    }

    setError(undefined);
    stopCapture();
    setSingleRemapTarget(remapTarget);
    setWizardState((state) => ({
      ...state,
      stepIndex,
    }));
  };

  const onSave = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!complete) {
      setError('Finish or skip all controls before saving this profile.');
      return;
    }

    setIsSaving(true);
    setError(undefined);

    try {
      const profile: ControllerProfile = {
        profileId:
          effectiveSaveMode === 'edit' && initialProfile
            ? initialProfile.profileId
            : `profile:${crypto.randomUUID()}`,
        name: profileName.trim() || 'Controller Profile',
        deviceId: resolveDeviceId(wizardState, initialProfile?.deviceId),
        romHash,
        deadzone: Math.min(0.9, Math.max(0, deadzone)),
        bindings: wizardState.bindings,
        updatedAt: Date.now(),
      };

      await onComplete(profile);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Unable to save controller profile.';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="panel wizard-panel" aria-label="Controller mapping wizard">
      <header className="wizard-header">
        <h2>{effectiveSaveMode === 'edit' ? 'Edit Controller Profile' : 'Controller Mapping Wizard'}</h2>
        <p>Step through each N64 control and press the input you want to map.</p>
        <div className="wizard-actions wizard-preset-row">
          <button type="button" className="preset-button" onClick={onApplyKeyboardPreset} disabled={isCapturing || isSaving}>
            Use Keyboard Preset
          </button>
          <p className="wizard-preset-hint">WASD stick, IJKL C-buttons, arrows for D-Pad, X/C for A/B.</p>
        </div>
        <div className="wizard-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="wizard-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </header>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="wizard-main">
        <div className="wizard-capture">
          {target ? (
            <>
              <h3>{controlPrompt(target)}</h3>
              <p>Current target: <strong>{CONTROL_LABELS[target]}</strong></p>
              {singleRemapTarget === target ? (
                <p className="wizard-preset-hint">
                  Quick remap mode: this update applies only to <strong>{CONTROL_LABELS[target]}</strong>.
                </p>
              ) : null}
              <p className="wizard-preset-hint">
                {isCapturing ? 'Listening now. Press the button you want mapped.' : 'Capture paused. Press recapture to listen again.'}
              </p>
              <div className="wizard-actions">
                <button type="button" onClick={onCapture} disabled={isCapturing || isSaving}>
                  {isCapturing ? 'Listening…' : 'Recapture Input'}
                </button>
                <button type="button" onClick={onBack} disabled={isCapturing || isSaving || wizardState.stepIndex === 0}>
                  {singleRemapTarget === target ? 'Cancel Quick Remap' : 'Back'}
                </button>
                <button type="button" onClick={onSkip} disabled={isSaving}>
                  {singleRemapTarget === target ? 'Skip Quick Remap' : 'Skip'}
                </button>
                <button type="button" onClick={onReset} disabled={isCapturing || isSaving}>
                  Reset
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>All controls reviewed</h3>
              <p>You can now save this profile.</p>
              <div className="wizard-actions">
                <button type="button" onClick={onBack} disabled={isCapturing || isSaving || wizardState.stepIndex === 0}>
                  Back
                </button>
                <button type="button" onClick={onReset} disabled={isCapturing || isSaving}>
                  Reset
                </button>
              </div>
            </>
          )}
        </div>

        <div className="wizard-summary">
          <h3>Mapped Controls</h3>
          <ul>
            {summary.map((entry) => (
              <li key={entry.target} className={singleRemapTarget === entry.target ? 'wizard-summary-item-active' : undefined}>
                <span>{entry.label}</span>
                <span>{entry.bound ? bindingToLabel(wizardState.bindings[entry.target]!) : 'Not mapped'}</span>
                {effectiveSaveMode === 'edit' ? (
                  <button
                    type="button"
                    onClick={() => onRemapSingleControl(entry.target)}
                    disabled={isSaving || isCapturing}
                  >
                    {singleRemapTarget === entry.target ? (isCapturing ? 'Listening…' : 'Remap Selected') : 'Remap Only'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <form className="wizard-footer" onSubmit={(event) => void onSave(event)}>
        <label>
          Profile Name
          <input
            type="text"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            disabled={isSaving}
            maxLength={50}
          />
        </label>

        <label>
          Analog Deadzone ({deadzone.toFixed(2)})
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={deadzone}
            onChange={(event) => setDeadzone(Number(event.target.value))}
            disabled={isSaving}
          />
        </label>

        <div className="wizard-actions">
          <button type="submit" disabled={!complete || isSaving || isCapturing}>
            {isSaving ? 'Saving…' : effectiveSaveMode === 'edit' ? 'Update Profile' : 'Save Profile'}
          </button>
          <button type="button" onClick={onCancelWizard} disabled={isSaving || isCapturing}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}
