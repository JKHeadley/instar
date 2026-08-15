/**
 * One identity oracle that can speak for BOTH kinds of credential slot.
 *
 * `IdentityOracle.resolveSlotTenant(slot)` is handed a directory path and nothing
 * else — no framework, no provider. The production implementation answers by
 * calling Anthropic's OAuth profile endpoint, so it can only ever speak for a
 * claude-code slot. Handed a Codex home it returns `unavailable`, and because the
 * subscription pool refuses to enrol an account whose slot identity cannot be
 * verified, Codex accounts could not be enrolled at all — the pool held six
 * Anthropic accounts and zero Codex ones while both Codex logins sat
 * authenticated on disk.
 *
 * Since the contract carries no framework, the slot has to identify ITSELF. It
 * can: a Codex home holds `auth.json` with an OIDC `id_token`; a Claude home does
 * not. That is a content discriminator, not a guess from the path name — a slot
 * renamed or symlinked anywhere still answers correctly.
 *
 * ## Order, and why Codex is tried first
 *
 * The Codex probe is a local file read that returns immediately when the file is
 * absent, so trying it first costs a `stat` on a Claude slot. The reverse order
 * would send every Codex enrolment through a doomed network round-trip to
 * Anthropic before failing. Cheap-and-local first, network second.
 *
 * A directory holding BOTH credential kinds resolves as Codex. That is
 * deterministic rather than correct-by-nature; it is not a shape instar creates,
 * and the alternative (refusing to answer) would be worse — it would block
 * enrolment on an ambiguity nobody has.
 *
 * ## What this does NOT change
 *
 * The Anthropic path is untouched: same oracle, same call, same result, same
 * quarantine-never-repair semantics for an unverifiable slot. This composes; it
 * does not reimplement. And identity remains a LABEL — it names and de-duplicates
 * a pool row and grants nothing.
 */

import type { IdentityOracle, IdentityOracleResult } from './CredentialLocationLedger.js';
import {
  readCodexSlotIdentity,
  type CodexSlotIdentity,
} from '../providers/adapters/openai-codex/codexSlotIdentity.js';

export interface CompositeCredentialIdentityOracleDeps {
  /** The existing (Anthropic OAuth) oracle. Used verbatim for non-Codex slots. */
  anthropic: IdentityOracle;
  /** Injected for tests; production reads the real credential file. */
  readCodex?: (codexHome: string) => CodexSlotIdentity;
}

export class CompositeCredentialIdentityOracle implements IdentityOracle {
  private readonly anthropic: IdentityOracle;
  private readonly readCodex: (codexHome: string) => CodexSlotIdentity;

  constructor(deps: CompositeCredentialIdentityOracleDeps) {
    this.anthropic = deps.anthropic;
    this.readCodex = deps.readCodex ?? readCodexSlotIdentity;
  }

  async resolveSlotTenant(slot: string): Promise<IdentityOracleResult> {
    let codex: CodexSlotIdentity;
    try {
      codex = this.readCodex(slot);
    } catch {
      /* @silent-fallback-ok: the Codex probe is a best-effort discriminator. If it
         throws (it is written not to), the slot is simply treated as non-Codex and
         the Anthropic path answers — the pre-existing behaviour. Failing the whole
         resolution here would REMOVE the ability to enrol claude-code accounts,
         which is a strictly worse outcome than an unanswered Codex probe. */
      return this.anthropic.resolveSlotTenant(slot);
    }

    if (!codex.unavailable && codex.email) {
      return { email: codex.email };
    }

    // `auth-file-missing` is the ordinary "this is not a Codex slot" answer, so it
    // falls through silently. Any OTHER Codex reason means the slot IS a Codex
    // home that could not identify itself — Anthropic cannot speak for it either,
    // so report it honestly instead of masking it as an Anthropic failure.
    if (codex.reason && codex.reason !== 'auth-file-missing') {
      return { unavailable: true, reason: `codex-slot-${codex.reason}` };
    }

    return this.anthropic.resolveSlotTenant(slot);
  }
}

/**
 * The (provider, framework) pairs whose credential slot identity can actually be
 * VERIFIED — i.e. the pairs some oracle above can answer for.
 *
 * This exists because the enrolment route used to carry the answer inline as
 * `provider !== 'anthropic' || framework !== 'claude-code'`. That was correct while
 * Anthropic was the only oracle, and it went stale the moment a Codex oracle was
 * added: the route refused Codex BEFORE the oracle was ever asked, so a Codex account
 * still could not be enrolled even though the identity layer could now identify it.
 *
 * Hardcoding a second pair at the callsite would repeat exactly that bug on the third
 * oracle. Keeping the list HERE, beside the oracle that implements it, means adding an
 * oracle and declaring what it covers are the same edit.
 *
 * Note what this list is NOT: it is not a claim that a given slot WILL verify, only
 * that something can be asked. The oracle still decides, and an unidentifiable slot is
 * still refused — this gate only stops us refusing without asking.
 */
export const IDENTITY_VERIFIABLE_SLOTS: ReadonlyArray<{
  readonly provider: string;
  readonly framework: string;
}> = [
  { provider: 'anthropic', framework: 'claude-code' },
  { provider: 'openai', framework: 'codex-cli' },
];

/** True when some identity oracle can be asked about this provider/framework pair. */
export function isIdentityVerifiableSlot(provider: unknown, framework: unknown): boolean {
  return IDENTITY_VERIFIABLE_SLOTS.some(
    (s) => s.provider === provider && s.framework === framework,
  );
}
