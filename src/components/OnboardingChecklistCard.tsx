import { Link } from 'react-router-dom';

import {
  onboardingChecklistVisible,
  onboardingProgressPercent,
  onboardingStepDescription,
  onboardingStepOrder,
  onboardingStepTitle,
  useOnboardingStore,
} from '../state/onboardingStore';
import type { OnboardingStep } from '../types/ux';

interface ChecklistAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

interface OnboardingChecklistCardProps {
  className?: string;
  title?: string;
  actions?: Partial<Record<OnboardingStep, ChecklistAction>>;
}

export function OnboardingChecklistCard({
  className,
  title = 'First-Run Checklist',
  actions = {},
}: OnboardingChecklistCardProps) {
  const progress = useOnboardingStore((state) => state.progress);
  const dismissChecklist = useOnboardingStore((state) => state.dismissChecklist);

  if (!onboardingChecklistVisible(progress)) {
    return null;
  }

  const percent = onboardingProgressPercent(progress);
  const orderedSteps = onboardingStepOrder();

  return (
    <section className={`onboarding-checklist panel ${className ?? ''}`.trim()} aria-label="First-run onboarding checklist">
      <div className="panel-header-inline">
        <h2>{title}</h2>
        <span className="status-pill">{percent}% complete</span>
      </div>
      <p className="online-subtle">Complete these steps once to reduce setup friction across local and online play.</p>
      <ul className="onboarding-checklist-steps">
        {orderedSteps.map((step) => {
          const done = progress.steps[step];
          const action = actions[step];

          return (
            <li key={step} className={done ? 'onboarding-step done' : 'onboarding-step'}>
              <div className="onboarding-step-copy">
                <p>
                  <strong>{onboardingStepTitle(step)}</strong>{' '}
                  <span className={`status-pill ${done ? 'status-good' : 'status-warn'}`}>{done ? 'Done' : 'Pending'}</span>
                </p>
                <p className="online-subtle">{onboardingStepDescription(step)}</p>
              </div>
              {done || !action ? null : action.to ? (
                <Link to={action.to}>{action.label}</Link>
              ) : (
                <button type="button" onClick={action.onClick}>
                  {action.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="wizard-actions">
        <button type="button" onClick={dismissChecklist}>Dismiss Checklist</button>
      </div>
    </section>
  );
}
