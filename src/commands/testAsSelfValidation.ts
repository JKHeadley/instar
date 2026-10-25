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

import fs from 'node:fs';
import path from 'node:path';

export interface TargetGuardOptions {
  /** Absolute path of the agent home the command is running FROM (never a target). */
  canonicalHome: string;
  /** Agent names that must never be used as a throwaway target (e.g. ['bob']). */
  protectedNames: string[];
  /** Optional: absolute homes that are off-limits regardless of name (e.g. a known Bob path). */
  protectedHomes?: string[];
  /**
   * Optional: every live agent home on this machine (e.g. each ~/.instar/agents/*).
   * The teardown sweeps processes naming the target path and tmux sessions named
   * `<basename(target)>-*`, so a target may be neither an ANCESTOR of any of these
   * homes nor share a basename with one (ACT-064 second-pass review).
   */
  agentHomes?: string[];
}

export interface GuardResult {
  ok: boolean;
  /** Stable machine-readable reason code (also the suggested process exit semantics). */
  code: 'ok' | 'target-is-canonical' | 'target-is-protected' | 'target-is-ancestor' | 'target-name-collides' | 'raw-token-on-cli' | 'empty-target';
  reason?: string;
}

/** Telegram bot tokens look like `<8-10 digits>:<35+ url-safe chars>`. */
const RAW_TELEGRAM_TOKEN = /^\d{8,10}:[A-Za-z0-9_-]{30,}$/;

/** A GitHub/Slack/OpenAI token shape, for the raw-token-on-cli guard. */
const RAW_OTHER_TOKEN = /^(gh[posru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-(?:proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]{20,})$/;

/** True if `value` looks like a raw secret token (must NOT be accepted on argv). */
export function isRawToken(value: string): boolean {
  const v = value.trim();
  return RAW_TELEGRAM_TOKEN.test(v) || RAW_OTHER_TOKEN.test(v);
}

/** Normalize a path for comparison (resolve + strip trailing sep). */
/** Resolve symlinks for the longest existing prefix; the remainder is appended unchanged. */
function realOrSelf(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

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

  // The teardown signals every process whose argv names a path under the target,
  // and every tmux session prefixed `<basename>-`. Refuse targets for which that
  // sweep could reach a real agent.
  const homes = [canonical, ...(opts.protectedHomes ?? []), ...(opts.agentHomes ?? [])].map(norm);
  const tReal = realOrSelf(t);
  for (const h of homes) {
    const hReal = realOrSelf(h);
    if (tReal === hReal) {
      return {
        ok: false,
        code: 'target-is-canonical',
        reason: `Refusing target ${t}: it resolves to the agent home ${h}.`,
      };
    }
    if (t === path.parse(t).root || h.startsWith(t + path.sep) || hReal.startsWith(tReal + path.sep)) {
      return {
        ok: false,
        code: 'target-is-ancestor',
        reason: `Refusing target ${t}: it contains a real agent home (${h}); teardown would stop that agent's processes.`,
      };
    }
    // tmux sessions are `<agentBase>-*`; the reaper kills `<base>-*`. They
    // overlap when the names are equal or either is a dash-prefix of the other.
    const hb = path.basename(h).toLowerCase();
    if (hb === base || hb.startsWith(base + '-') || base.startsWith(hb + '-')) {
      return {
        ok: false,
        code: 'target-name-collides',
        reason: `Refusing target ${t}: its name "${base}" matches the agent home ${h}; teardown would stop that agent's sessions.`,
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
