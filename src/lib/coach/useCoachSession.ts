'use client';

/**
 * The live narrator tier, shared by every coach surface.
 *
 * A download started on the Bots card must relabel the Analyse panel, and a
 * model restored at launch must be visible to the coach game without a
 * remount. `session` owns the value; this hook is the React subscription.
 */

import { useEffect, useState } from 'react';

import { CoachSession, coachSession, subscribeCoach } from './session';

export function useCoachSession(): CoachSession {
  const [state, setState] = useState<CoachSession>(coachSession);
  useEffect(() => {
    setState(coachSession());
    return subscribeCoach(() => setState(coachSession()));
  }, []);
  return state;
}
