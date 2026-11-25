export interface ManagedStopRolloutBoundary {
  fileKey: string;
  turnId: string;
  endOffset: number;
}

export interface ManagedStopEnrollment {
  launchId?: string;
  homeIdentity?: string;
  sessionId: string;
  machineId: string;
  ownerEpoch: number;
  state: 'pending' | 'active' | 'retired';
  rolloutFileKey?: string;
  remaining: number;
  issuedCycles: readonly string[];
  outstanding?: { cycle: string; marker: string; boundary?: ManagedStopRolloutBoundary };
}

export interface ManagedStopInput {
  enabled: boolean;
  sessionId: string;
  machineId: string;
  ownerEpoch: number;
  actionOpen: boolean;
  paused: boolean;
  cycle: string;
  marker: string;
  boundary?: ManagedStopRolloutBoundary;
  receipt?: { cycle: string; marker: string };
}

export interface ManagedStopDecision {
  enrollment: ManagedStopEnrollment;
  directive?: { cycle: string; marker: string };
}

/**
 * Evaluate inside the durable work-claim transaction. Return a directive only
 * after the resulting enrollment is committed. Identity, cycle attribution
 * and receipt provenance are verified by the caller before this transition.
 */
export function decideManagedCodexStop(
  current: ManagedStopEnrollment,
  input: ManagedStopInput,
): ManagedStopDecision {
  if (current.sessionId !== input.sessionId || current.machineId !== input.machineId
    || current.ownerEpoch !== input.ownerEpoch || current.state !== 'active'
    || !input.cycle || current.issuedCycles.includes(input.cycle)) {
    return { enrollment: current };
  }

  const outstanding = current.outstanding;
  const receipt = input.receipt;
  const enrollment = outstanding && receipt
    && outstanding.cycle === receipt.cycle && outstanding.marker === receipt.marker
    && input.cycle !== outstanding.cycle
    ? { ...current, outstanding: undefined }
    : current;

  if (!input.enabled || !input.actionOpen || input.paused || enrollment.remaining <= 0
    || enrollment.outstanding || !input.marker) {
    return { enrollment };
  }

  const directive = { cycle: input.cycle, marker: input.marker };
  return {
    enrollment: {
      ...enrollment,
      remaining: enrollment.remaining - 1,
      issuedCycles: [...enrollment.issuedCycles, input.cycle],
      outstanding: input.boundary ? { ...directive, boundary: input.boundary } : directive,
    },
    directive,
  };
}
