/**
 * Say ONCE, where the failure counts are, that better-sqlite3 could not load.
 *
 * WHY THIS EXISTS — a measured incident, 2026-08-15. A full local suite reported
 * 225 failing files. 108 of them were downstream of ONE fact: `better-sqlite3`
 * had no native binary in that checkout, because the install had skipped its
 * postinstall hook. Every affected subsystem degraded correctly and instar said
 * so in plain English, naming the exact remedy — **189 times**.
 *
 * And it did not help. I grepped that text and COUNTED it; I never read the three
 * lines underneath the one I was counting. Hours went into a completion-order
 * analysis, a replay, a prefix bisect and five dead hypotheses, for a question the
 * output had already answered.
 *
 * So this is not another message. It is the SAME message moved to the one place a
 * reader actually looks: the end of the run, beside the failure count. 189 lines
 * scattered through 21MB of log is not a signal — it is volume, and summarising is
 * how you avoid reading.
 *
 * DELIBERATELY NOT A GATE. instar degrades gracefully without better-sqlite3, and
 * most of the suite does not touch it, so refusing to run would trade a confusing
 * failure for a blocked one. This never fails, never skips, never changes an exit
 * code. It only makes an existing diagnosis legible.
 *
 * SCOPED TO ONE MODULE ON PURPOSE. Generalising to "native modules" would be
 * inventing a class from a single incident — the exact over-read this whole
 * episode was caused by.
 */
import { createRequire } from 'node:module';
import type { GlobalSetupContext } from 'vitest/node';

// This package is `"type": "module"`, so a bare `require` is not defined here.
// better-sqlite3 is a native CJS addon; `createRequire` is the idiom this repo
// already uses for exactly that (see tests/unit/fix-better-sqlite3-state.test.ts).
const requireCjs = createRequire(import.meta.url);

export interface NativeProbeResult {
  ok: boolean;
  /** First line of the failure, already trimmed. Empty when ok. */
  detail: string;
}

/**
 * Probe the module the way the suite actually uses it: load it AND open an
 * in-memory database. Loading alone is not enough — the incident's own signature
 * was `sqlite-runtime-broken: better-sqlite3 failed to open an in-memory DB`, so a
 * require-only probe would have reported healthy through the whole outage.
 *
 * `load` is injectable so both directions are testable without breaking the real
 * module — the negative control cannot be run any other way.
 */
export function probeBetterSqlite(load: () => unknown): NativeProbeResult {
  try {
    const Ctor = load() as new (path: string) => { close(): void };
    const db = new Ctor(':memory:');
    db.close();
    return { ok: true, detail: '' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: (msg.split('\n')[0] ?? '').trim() };
  }
}

/**
 * The banner. Pure, so a test can assert what a human would read rather than
 * asserting that some function was called.
 */
export function formatBanner(detail: string): string {
  return [
    '',
    '════════════════════════════════════════════════════════════════════════',
    '  better-sqlite3 could NOT load in this checkout for this run.',
    '',
    `  ${detail || '(no detail reported)'}`,
    '',
    '  Every sqlite-backed subsystem degraded for the whole run. Test failures',
    '  above that mention bindings, sqlite, or a store failing to open are most',
    '  likely DOWNSTREAM of this one fact, not separate defects.',
    '',
    '  Fix:  npm rebuild better-sqlite3        (or reinstall WITHOUT --ignore-scripts,',
    '                                           which skips the postinstall that',
    '                                           builds the native binary)',
    '',
    '  This is a notice, not a gate: nothing was blocked or skipped because of it.',
    '════════════════════════════════════════════════════════════════════════',
    '',
  ].join('\n');
}

/**
 * The decision, with both dependencies injectable — so BOTH branches are testable
 * with zero side effects. The silent-when-healthy branch is the one that matters
 * for over-block: this runs at the start of every suite on every machine, and a
 * banner on a healthy box would be pure noise. A test that could not exercise
 * that branch would be a check that cannot fail on the case that costs.
 */
export function runHealthCheck(
  probe: () => NativeProbeResult = () => probeBetterSqlite(() => requireCjs('better-sqlite3')),
  write: (s: string) => void = (s) => { process.stderr.write(s); },
): (() => void) | void {
  // The probe is wrapped even though the default one already catches internally.
  // This runs before EVERY suite on every machine: if it ever threw, it would take
  // the whole run down, which is a strictly worse outcome than the degraded state
  // it exists to describe. Belt-and-braces here is proportionate to that asymmetry.
  let result: NativeProbeResult;
  try {
    result = probe();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { ok: false, detail: `health probe itself failed: ${(msg.split('\n')[0] ?? '').trim()}` };
  }
  if (result.ok) return; // healthy box: completely silent, every run

  // One line now (cheap, and survives if teardown output is swallowed), and the
  // full banner at teardown — where the failure counts are.
  write('[native-module-health] better-sqlite3 unavailable — a banner will follow the run summary.\n');
  return () => { write(formatBanner(result.detail)); };
}

export default function setup(_ctx?: GlobalSetupContext): (() => void) | void {
  return runHealthCheck();
}
