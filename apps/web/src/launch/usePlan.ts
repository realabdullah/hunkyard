import type { ReviewOptions, ReviewPlan } from '@reviewlab/domain';
import { useEffect, useState } from 'react';
import { api } from '../api';

/** Loads the saved review defaults, then validates every edit against the server's planner. */
export const usePlan = () => {
  const [options, setOptions] = useState<ReviewOptions | null>(null);
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let alive = true;
    void api<ReviewPlan>('/review-plan').then(
      (value) => {
        if (alive) setOptions(value.options);
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : 'Cannot load review plan');
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!options) return;
    let alive = true;
    setChecking(true);
    const timer = setTimeout(() => {
      void api<ReviewPlan>('/review-plan', { method: 'POST', body: JSON.stringify(options) }).then(
        (value) => {
          if (!alive) return;
          setPlan(value);
          setError('');
          setChecking(false);
        },
        (cause: unknown) => {
          if (!alive) return;
          setPlan(null);
          setChecking(false);
          setError(cause instanceof Error ? cause.message : 'Invalid review plan');
        },
      );
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [options]);
  const ready = Boolean(plan && !checking && !error);
  return { options, setOptions, plan: ready ? plan : null, draftPlan: plan, error, checking };
};
