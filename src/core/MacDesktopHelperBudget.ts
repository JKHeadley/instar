/**
 * Wait budgets for the macOS desktop helper, and the one place a whole process can stretch
 * them.
 *
 * MacDesktopHost waits a fixed time for its native helper at each step (2 s for an ordinary
 * command, 4 s for a frame, ...). Those budgets fit the real helper, a small native binary.
 * The unit tests replace the helper with a Node script, and on a busy machine a Node process
 * can take longer than 2 s just to start: the test then fails with `mac-desktop-host-timeout`
 * although nothing is wrong (2026-11-18: two unrelated changes failed in the merge line on
 * desktop-displays; MacDesktopHostIdentity and MacDesktopHostCapture were retried for the same
 * reason all week).
 *
 * So every helper wait in MacDesktopHost is `macDesktopHelperBudgetMs(base)`: the base budget
 * times one process-wide scale. The scale is 1 unless something sets it, and at 1 every budget
 * is exactly its base. The test runner's setup file raises it for every test file.
 *
 * The scale can only lengthen a wait, never shorten one: a value that is not a finite number
 * of at least 1 is refused and the scale stays 1; a value above
 * MAC_DESKTOP_HELPER_BUDGET_SCALE_MAX is held at that cap.
 *
 * Kept in its own small module (no imports) so the setup file can set the scale without
 * loading MacDesktopHost, which would cache node:child_process ahead of a test's vi.mock.
 *
 * Production never calls `setMacDesktopHelperBudgetScale` (pinned by a source scan in
 * tests/unit/mac-desktop-helper-budget.test.ts).
 */

/** The largest scale accepted. A larger request is held here. */
export const MAC_DESKTOP_HELPER_BUDGET_SCALE_MAX = 20;

let scale = 1;

/**
 * Set this process's helper budget scale. `null` restores 1 (the production budgets). An
 * invalid value (not a number, NaN, infinite, below 1) also leaves the scale at 1; a value
 * above the cap is held at the cap. For test runners; production code does not call this.
 */
export function setMacDesktopHelperBudgetScale(next: number | null): void {
  scale = typeof next === 'number' && Number.isFinite(next) && next >= 1
    ? Math.min(next, MAC_DESKTOP_HELPER_BUDGET_SCALE_MAX) : 1;
}

/** The scale in effect in this process: 1 in production. */
export function macDesktopHelperBudgetScale(): number {
  return scale;
}

/** One helper wait: its production budget times the scale in effect. Never below the base. */
export function macDesktopHelperBudgetMs(baseMs: number): number {
  return scale === 1 ? baseMs : Math.round(baseMs * scale);
}

/**
 * The production budget for one run of the helper with `command`, before scaling: asking for
 * a permission waits on a person, a state operation walks files, a capture encodes a frame;
 * everything else answers at once.
 */
export function macDesktopHelperRunBaseMs(command: string): number {
  return command === 'request-permission' ? 15_000 : command === 'capture' ? 4_000
    : command === 'state-op' ? 10_000 : 2_000;
}
