/**
 * testAsSelfValidation — pure input guards for `instar test-as-self`.
 *
 * The harness deploys a THROWAWAY agent. These guards make it structurally
 * impossible to (a) point the throwaway at a real/protected agent home or
 * (b) accept a raw bot token on the command line (tokens must flow through
 * Secret Drop — never argv/env/transcript). Pure + synchronous so the
 * decision boundary is fully unit-testable; the command wires real paths in.
 *
 * Spec: MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS §Track F (the Part 2.1 harness),
 * "Forbidden inputs".
 */

import path from 'node:path';

export interface TargetGuardOptions {
  /** Absolute path of the agent home the command is running FROM (never a target). */
  canonicalHome: string;
  /** Agent names that must never be used as a throwaway target (e.g. ['bob']). */
  protectedNames: string[];
  /** Optional: absolute homes that are off-limits regardless of name (e.g. a known Bob path). */
  protectedHomes?: string[];
}

export interface GuardResult {
  ok: boolean;
  /** Stable machine-readable reason code (also the suggested process exit semantics). */
  code: 'ok' | 'target-is-canonical' | 'target-is-protected' | 'raw-token-on-cli' | 'empty-target';
  reason?: string;
}

/** Telegram bot tokens look like `<8-10 digits>:<35+ url-safe chars>`. */
const RAW_TELEGRAM_TOKEN = /^\d{8,10}:[A-Za-z0-9_-]{30,}$/;

/** A GitHub/Slack/OpenAI token shape, for the raw-token-on-cli guard. */
const RAW_OTHER_TOKEN = /^(gh[posru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})$/;

/** True if `value` looks like a raw secret token (must NOT be accepted on argv). */
export function isRawToken(value: string): boolean {
  const v = value.trim();
  return RAW_TELEGRAM_TOKEN.test(v) || RAW_OTHER_TOKEN.test(v);
}

/** Normalize a path for comparison (resolve + strip trailing sep). */
function norm(p: string): string {
  const r = path.resolve(p);
  return r.length > 1 && r.endsWith(path.sep) ? r.slice(0, -1) : r;
}

/**
 * Validate the `--target` throwaway-home path. Rejects:
 *  - empty,
 *  - the canonical (running) agent home,
 *  - a home whose final path segment is a protected agent name (e.g. `bob`),
 *  - any explicitly protected home path.
 */
export function validateTarget(target: string | undefined, opts: TargetGuardOptions): GuardResult {
  if (!target || !target.trim()) {
    return { ok: false, code: 'empty-target', reason: '--target is required (a throwaway agent home path).' };
  }
  const t = norm(target);
  const canonical = norm(opts.canonicalHome);

  if (t === canonical) {
    return {
      ok: false,
      code: 'target-is-canonical',
      reason: `Refusing to use the canonical agent home (${canonical}) as a throwaway target. Pick an isolated directory.`,
    };
  }

  const base = path.basename(t).toLowerCase();
  if (opts.protectedNames.map((n) => n.toLowerCase()).includes(base)) {
    return {
      ok: false,
      code: 'target-is-protected',
      reason: `Refusing to use a protected agent home (name "${base}") as a throwaway target.`,
    };
  }

  for (const ph of opts.protectedHomes ?? []) {
    if (t === norm(ph)) {
      return {
        ok: false,
        code: 'target-is-protected',
        reason: `Refusing to use protected home ${norm(ph)} as a throwaway target.`,
      };
    }
  }

  return { ok: true, code: 'ok' };
}

/**
 * Validate the `--bot-token` argument. It must be a Secret Drop ID reference,
 * NEVER a raw token. A raw-token value is refused so a secret can't land in
 * argv / shell history / the transcript.
 */
export function validateBotTokenArg(arg: string | undefined): GuardResult {
  if (!arg) return { ok: true, code: 'ok' }; // absent → harness will open a Secret Drop request
  if (isRawToken(arg)) {
    return {
      ok: false,
      code: 'raw-token-on-cli',
      reason: 'Refusing a raw bot token on the command line. Pass a Secret Drop ID; the token is retrieved in-memory, never via argv.',
    };
  }
  return { ok: true, code: 'ok' };
}
