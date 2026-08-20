/**
 * AgentIdentityDivergenceDetector — notice when one agent is publishing two identities.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §4.
 * Constitution: "Verify the State, Not Its Symbol"; "No Silent Degradation".
 *
 * WHY. The 2026-08-19 split went FOUR DAYS unreported and surfaced only while investigating an
 * unrelated request. A repair path with no detector only ever fixes the splits somebody happens
 * to notice. This is the part that makes the failure visible at all.
 *
 * ── WHAT IT READS, AND WHY THAT IS THE STATE RATHER THAN A SYMBOL ────────────────────────
 * The SYMBOL would be the identity file on disk. The STATE is what each machine actually
 * PUBLISHES as its routing/signing identity, which is what peers and verifiers resolve. So the
 * comparison is over each machine's live published fingerprint, gathered from the peers
 * themselves — not over files this machine can read locally.
 *
 * ── EVERY MACHINE OBSERVES; ONLY THE NOTICE IS DEDUPED ───────────────────────────────────
 * An earlier design had only the lease holder observe. That fails in the two cases that matter
 * most: the lease holder may BE the diverged machine (it was, in the live incident) and it may
 * be the isolated one. So each machine compares independently and the single-notice property
 * comes from deduping on the episode key, never from restricting who is allowed to look.
 *
 * ── SIGNAL ONLY ──────────────────────────────────────────────────────────────────────────
 * It reports. It never repairs, never blocks a send, never changes an identity. Repair is §3
 * and requires an operator decision; conflating detection with repair is how a detector
 * acquires the authority to take an agent off the network.
 */

export interface MachineIdentityObservation {
  machineId: string;
  machineName: string;
  /** The fingerprint this machine PUBLISHES, or null when it could not be reached/read. */
  publishedFingerprint: string | null;
  /** Why it is null — surfaced so "unreachable" never renders as "agrees". */
  unreachableReason?: string;
}

export type DivergenceState = 'agree' | 'disagree' | 'cannot-tell';

export interface DivergenceVerdict {
  state: DivergenceState;
  /** Distinct fingerprints observed, sorted — the episode's identity. */
  fingerprints: string[];
  /** Machines grouped by the fingerprint they publish. */
  byFingerprint: Record<string, string[]>;
  /** Machines that could not be read, with the reason. Never folded into agreement. */
  unreadable: Array<{ machineId: string; machineName: string; reason: string }>;
  /** Stable per-episode key: same split → same key → one notice, not one per boot. */
  episodeKey: string | null;
  /** True only for `disagree`. `cannot-tell` is reported, never paged. */
  shouldNotify: boolean;
}

/**
 * Compare what the machines of one agent publish.
 *
 * Pure over the observations so the decision is testable without a live mesh.
 */
export function evaluateDivergence(input: {
  agentName: string;
  observations: MachineIdentityObservation[];
}): DivergenceVerdict {
  const unreadable = input.observations
    .filter((o) => o.publishedFingerprint === null)
    .map((o) => ({
      machineId: o.machineId,
      machineName: o.machineName,
      reason: o.unreachableReason ?? 'unknown',
    }));

  const readable = input.observations.filter(
    (o): o is MachineIdentityObservation & { publishedFingerprint: string } =>
      typeof o.publishedFingerprint === 'string' && o.publishedFingerprint.length > 0,
  );

  const byFingerprint: Record<string, string[]> = {};
  for (const o of readable) {
    (byFingerprint[o.publishedFingerprint] ??= []).push(o.machineName);
  }
  const fingerprints = Object.keys(byFingerprint).sort();

  // Fewer than two readable machines cannot demonstrate agreement OR disagreement. Reporting
  // that as `agree` would be the precise failure this detector exists to prevent: absence of
  // evidence rendered as evidence of absence.
  if (readable.length < 2) {
    return {
      state: 'cannot-tell',
      fingerprints,
      byFingerprint,
      unreadable,
      episodeKey: null,
      shouldNotify: false,
    };
  }

  if (fingerprints.length === 1) {
    // Genuine agreement among those that answered. Any unreadable machine is still surfaced —
    // "two agree and one is unreachable" is not the same as "all three agree".
    return {
      state: 'agree',
      fingerprints,
      byFingerprint,
      unreadable,
      episodeKey: null,
      shouldNotify: false,
    };
  }

  return {
    state: 'disagree',
    fingerprints,
    byFingerprint,
    unreadable,
    // Keyed on the SET of fingerprints, so the same split reported from any machine, on any
    // boot, collapses to one notice — and a split that CHANGES (a machine repaired, another
    // diverged) is a new episode the operator is told about.
    episodeKey: `agent-identity-split:${input.agentName}:${fingerprints.join('+')}`,
    shouldNotify: true,
  };
}

/**
 * Operator-facing text for a split. Plain language: the operator's question is "is my agent
 * one agent?", not "what is the hex".
 *
 * Fingerprints appear as supporting detail only — the Operator-Surface Quality standard, and
 * the same reasoning that made the repair ceremony pick between descriptions rather than hex.
 */
export function divergenceNotice(
  verdict: Extract<DivergenceVerdict, { state: DivergenceState }>,
  agentName: string,
): { title: string; body: string } {
  const groups = Object.entries(verdict.byFingerprint)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([fp, machines]) => `  • ${machines.join(', ')} — identity ${fp.slice(0, 8)}…`);

  const unreadableLine = verdict.unreadable.length
    ? `\n\nCouldn't check: ${verdict.unreadable.map((u) => `${u.machineName} (${u.reason})`).join(', ')}. ` +
      `That's unknown, not agreement.`
    : '';

  return {
    title: `${agentName} is running as more than one identity`,
    body:
      `Machines that should all be the same agent are publishing different identities:\n\n` +
      `${groups.join('\n')}\n\n` +
      `Messages addressed to one of these may not reach the machines using the other, and ` +
      `anything signed on a machine in the smaller group won't verify as ${agentName}.\n\n` +
      `Fixing it needs one decision from you about which is the real one — nothing is changed ` +
      `automatically, because repairing to the wrong identity would take ${agentName} off the ` +
      `network entirely.${unreadableLine}`,
  };
}
