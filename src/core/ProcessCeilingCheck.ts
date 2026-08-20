/**
 * ProcessCeilingCheck — report the EFFECTIVE process ceiling, never assume the plist is it.
 *
 * Spec: docs/specs/launchd-process-ceiling-floor.md §3.
 * Constitution: "Verify the State, Not Its Symbol"; "No Manual Work (user *or* agent)".
 *
 * WHY THIS EXISTS. `PostUpdateMigrator.migrateLaunchdProcessCeiling` raises the
 * `NumberOfProcesses` value in the agent's launchd plist. That value is a SYMBOL. The STATE
 * that matters is the `RLIMIT_NPROC` the running processes actually inherited — and the two
 * diverge for a real, expected window, because launchd applies the raised ceiling only to
 * what it starts NEXT. A migrated machine keeps running under the old ceiling until it
 * restarts.
 *
 * That divergence is not hypothetical; it is the 2026-08-19 incident. The plist was raised
 * at 10:26 and the machine kept crashing under the old ceiling until 12:18, and the only
 * reason it restarted at all is that the agent asked the operator by hand. Two other
 * machines carried the same ceiling and would have received no such prompt. Relying on
 * release-note prose plus an agent remembering is exactly the failure the two standards
 * above name.
 *
 * SIGNAL, NEVER AUTHORITY. Everything here reads and reports. It does not restart the
 * agent, reload launchd, refuse to boot, or gate any work. A wrong reading costs one wrong
 * notice, never an outage — the correct blast radius for a check whose entire job is to
 * report that a limit is wrong.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAUNCHD_PROCESS_CEILING_FLOOR,
  readLaunchdProcessCeilings,
} from './PostUpdateMigrator.js';

/**
 * The live soft `RLIMIT_NPROC` of THIS process, or `null` when it cannot be read.
 *
 * `null` is a first-class result, not an error: a platform without the limit, or a runtime
 * that does not expose it, is a real state. It must stay explicit rather than collapse to a
 * flattering number — a fabricated "healthy" would silence a genuine gap, and a fabricated
 * "broken" would nag every correctly-configured machine forever.
 *
 * The reading comes from the process's own report rather than from any file instar wrote,
 * which is what makes it corroboration of the state rather than a second look at the
 * symbol. It spawns nothing — deliberately, since the failure being detected is precisely
 * an inability to spawn.
 */
export function readEffectiveProcessCeiling(
  getReport: () => unknown = () => process.report?.getReport(),
): number | null {
  let report: unknown;
  try {
    report = getReport();
  } catch {
    return null;
  }
  const limits = (report as { userLimits?: Record<string, { soft?: unknown }> } | undefined)
    ?.userLimits;
  const soft = limits?.['max_user_processes']?.soft;
  // `unlimited` arrives as a string on some platforms; only a finite positive number is a
  // ceiling this check can reason about. Anything else is honestly unknown.
  if (typeof soft !== 'number' || !Number.isFinite(soft) || soft <= 0) return null;
  return soft;
}

/**
 * What the boot check concluded, and why.
 *
 * TWO states notify, and they are deliberately DISTINCT because they ask for different
 * things from the operator (round-2 cross-model finding):
 *
 * - `raise`  — the plist is corrected and the machine simply needs its restart.
 * - `repair` — the machine is running an unsafe ceiling and the plist was NOT corrected
 *              (the migration never ran, failed, or the plist is missing/malformed). A
 *              restart would NOT help. Folding this into `raise` would tell the operator to
 *              restart a machine that would come back just as broken; folding it into
 *              silence — the first draft's behaviour — leaves a machine crashing on this
 *              exact bug with nobody told.
 * - `future-repair` — the machine is running SAFELY right now, but its EXISTING plist is
 *              unreadable, half-raised, or below the floor, so its NEXT restart MAY land it
 *              in the unsafe state. "May", not "would": when the plist is below the floor
 *              the outcome is known, but when it cannot be READ the next effective limit is
 *              genuinely unknown — and the notice says so rather than asserting a drop it
 *              cannot predict. A draft treated this whole row as `ok` on the reasoning that
 *              the plist is "a question about the future" — but a silent future failure is
 *              exactly the class this spec exists to end, and the restart that triggers it
 *              is routine. Lower urgency than `repair` (nothing is broken yet), never
 *              silent.
 */
export type ProcessCeilingVerdict =
  | { state: 'ok'; effective: number; floor: number }
  | { state: 'unknown'; reason: 'effective-unreadable' | 'not-applicable' }
  | { state: 'raise'; effective: number; floor: number; dedupeKey: string }
  | { state: 'repair'; effective: number; floor: number; dedupeKey: string }
  | { state: 'future-repair'; effective: number; floor: number; dedupeKey: string };

/**
 * Compare the EFFECTIVE ceiling against the floor and decide whether the operator should be
 * told this machine still needs its restart.
 *
 * Pure over its inputs so the decision is testable without a live process or a live plist.
 *
 * The answer space is enumerable — three states, one input, no competing signals — so the
 * conservative default on the unmeasurable branch is silence (`unknown`), never a guess.
 *
 * `plistCeilings` is passed so the check can tell "this machine was migrated and awaits its
 * restart" (notify) from "this machine was never migrated at all" (say nothing here — the
 * migration's own result reports that, and duplicating it would produce two voices for one
 * condition).
 */
export function evaluateProcessCeiling(input: {
  platform: string;
  effective: number | null;
  plistCeilings: number[];
  /**
   * Whether a launchd plist EXISTS for this agent at all.
   *
   * Absent is NOT the same as "present but wrong" (found 2026-08-19 by this repo's own suite,
   * after the first version shipped): a machine with no launchd plist is not launchd-managed,
   * so it has no managed ceiling to lose at its next restart, and telling its operator that a
   * restart "may lose" the limit is a false alarm. The first version conflated the two and
   * raised `future-repair` on every healthy unmanaged machine — including inside the test
   * suite, where it polluted unrelated tests' attention items. That is how it was caught.
   *
   * Defaults TRUE so an omitted flag keeps the stricter reading rather than silently
   * suppressing a real warning.
   */
  plistPresent?: boolean;
  machineId: string;
  /**
   * A host fingerprint mixed into the dedupe key alongside `machineId` (round-10 review
   * finding). `machineId` alone is not enough HERE, even though it is elsewhere: if two
   * machines ever collided on an id, the second's item would be suppressed while the
   * first's is open — and for this feature that suppressed item can be the HIGH `repair`
   * notice for a machine that is actively crashing. Mixing in the hostname makes a
   * collision cost a duplicate notice instead of a swallowed one, which is the right
   * direction for a safety notice.
   */
  hostFingerprint?: string;
  floor?: number;
}): ProcessCeilingVerdict {
  const floor = input.floor ?? LAUNCHD_PROCESS_CEILING_FLOOR;
  const who = `${input.machineId}@${input.hostFingerprint ?? 'unknown-host'}`;
  if (input.platform !== 'darwin') return { state: 'unknown', reason: 'not-applicable' };
  if (input.effective === null) return { state: 'unknown', reason: 'effective-unreadable' };
  const plistPresent = input.plistPresent ?? true;
  const plistOk =
    input.plistCeilings.length > 0 && input.plistCeilings.every((v) => v >= floor);
  if (input.effective >= floor) {
    if (plistOk) return { state: 'ok', effective: input.effective, floor };
    // Safe now AND not launchd-managed: there is no managed ceiling to lose on restart, so
    // there is nothing to warn about. Silence here is accuracy, not suppression.
    if (!plistPresent) return { state: 'unknown', reason: 'not-applicable' };
    // Safe now, unsafe after the next restart. Reported at lower urgency, never silently.
    return {
      state: 'future-repair',
      effective: input.effective,
      floor,
      dedupeKey: `process-ceiling:future-repair:${who}:${input.effective}:${floor}`,
    };
  }
  // Effective is below the floor: this machine IS running an unsafe ceiling. Which of the
  // two notifying states applies depends on whether the plist has been corrected, because
  // that decides whether a restart would actually fix it.
  //
  // Deduped on the machine AND the two numbers, so an un-restarted week produces ONE item
  // rather than one per boot, while a genuinely changed reading produces a fresh one. The
  // state is part of the key so a machine that moves from `repair` to `raise` (the
  // migration lands, restart still pending) tells the operator the NEW thing to do.
  const state = plistOk ? ('raise' as const) : ('repair' as const);
  return {
    state,
    effective: input.effective,
    floor,
    dedupeKey: `process-ceiling:${state}:${who}:${input.effective}:${floor}`,
  };
}

/**
 * The operator-facing text for a `raise` verdict. Plain language, no commands, no file
 * paths: the action is "restart this machine when convenient", which needs no terminal.
 */
export function processCeilingNotice(
  verdict: Extract<ProcessCeilingVerdict, { state: 'raise' | 'repair' | 'future-repair' }>,
  machineName: string,
): { title: string; body: string } {
  if (verdict.state === 'future-repair') {
    return {
      title: `${machineName} is fine now, but a restart may lose that`,
      body:
        `This machine is currently running a process limit of ${verdict.effective}, which is ` +
        `fine. What is NOT confirmed is that it would come back this way: its saved setting is ` +
        `either below the ${verdict.floor} it should have, or could not be read at all. So a ` +
        `restart may lose the limit it is running on now.\n\n` +
        `Nothing is wrong at the moment and there is no hurry. It is worth sorting before the ` +
        `next restart, though, because at that point commands can start being refused for no ` +
        `visible reason. The update that corrects the saved setting either has not reached ` +
        `${machineName} yet or did not complete.`,
    };
  }
  if (verdict.state === 'repair') {
    return {
      title: `${machineName} is running too low a process limit, and a restart will not fix it`,
      body:
        `This machine is running under a process limit of ${verdict.effective}, below the ` +
        `${verdict.floor} it should have — and unlike the usual case, the corrected setting has ` +
        `NOT been saved, so restarting would bring it back just as it is.\n\n` +
        `While it stays this way, commands can be refused for no visible reason and the ` +
        `agent's server can crash outright. This one needs looking at rather than a restart; ` +
        `the update that corrects the setting either has not reached ${machineName} yet or did ` +
        `not complete.`,
    };
  }
  return {
    title: `${machineName} needs one restart to pick up its raised process limit`,
    body:
      `This machine is still running under a process limit of ${verdict.effective}, which is ` +
      `below the ${verdict.floor} it should have. The corrected setting is already saved — it ` +
      `only takes effect on programs started after a restart, so the running ones still carry ` +
      `the old limit.\n\n` +
      `While it stays this way, commands can be refused for no visible reason and the agent's ` +
      `server can crash outright. A normal restart of ${machineName}, whenever convenient, ` +
      `clears it. Nothing else is needed, and this notice will not repeat until something ` +
      `changes.`,
  };
}

/**
 * The `NumberOfProcesses` values declared in THIS agent's launchd plist, or `[]` when the
 * plist is absent/unreadable or the platform has none.
 *
 * Kept here rather than in the migrator so the boot check has a read-only path to the
 * symbol WITHOUT importing the migration machinery: the check compares the symbol against
 * the state, so it needs to see both, but it must never be able to write either.
 */
export function launchdPlistExistsForSelf(
  projectName: string,
  deps: { platform?: string; home?: string; exists?: (p: string) => boolean } = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const home = deps.home ?? process.env.HOME ?? '';
  if (!home) return false;
  const exists = deps.exists ?? ((f: string) => existsSync(f));
  return exists(join(home, 'Library', 'LaunchAgents', `ai.instar.${projectName}.plist`));
}

export function readLaunchdPlistCeilingsForSelf(
  projectName: string,
  deps: {
    platform?: string;
    home?: string;
    readFile?: (p: string) => string;
    parse?: (xml: string) => number[];
  } = {},
): number[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return [];
  const home = deps.home ?? process.env.HOME ?? '';
  if (!home) return [];
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf-8'));
  const parse = deps.parse ?? readLaunchdProcessCeilings;
  try {
    return parse(readFile(join(home, 'Library', 'LaunchAgents', `ai.instar.${projectName}.plist`)));
  } catch {
    // @silent-fallback-ok: an absent or unreadable plist is a REAL state (a machine not
    // installed via launchd). It yields [], which routes the verdict to `unknown` and
    // therefore to silence — never to a claim about a machine this check cannot see.
    return [];
  }
}
