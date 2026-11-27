/**
 * The agent identity a pairing must hand over (fb-1e30d109-e50).
 *
 * A new agent made by `instar init` with the Threadline relay off never created an agent
 * identity, because only the relay client created one. Its first `instar pair` then had
 * nothing to hand over, the joiner refused to mint (correctly — a joiner must never invent
 * one), and the join failed. Worse, once the joiner was registered the inviter itself counted
 * as "joined a mesh" and refused to create one later, so a retry failed the same way.
 *
 * The fix: the inviter creates the agent's identity at the moment it is still the agent's only
 * machine — after the pairing code is checked, BEFORE the joiner is registered — through the
 * guarded primitive (`IdentityManager.getOrCreate`, which still refuses wherever a registry
 * names another machine). When it cannot, the refusal is returned in plain words so the joiner
 * is told the real cause, never "the other machine is on an older version".
 */
import fs from 'node:fs';
import path from 'node:path';
import { IdentityManager, IdentityNotProvisionedError } from '../threadline/client/IdentityManager.js';
import { readAgentIdentityForHandover } from './AgentIdentityHandover.js';

/** Why the pairing response carries no agent identity (sent to the joiner; plain words in `detail`). */
export interface AgentIdentityAbsence {
  reason: 'inviter-mint-refused' | 'inviter-mint-failed' | 'inviter-identity-unreadable' | 'inviter-seal-refused' | 'inviter-seal-failed';
  detail: string;
}

export type EnsureFirstPairIdentityResult =
  | { ok: true; minted: boolean }
  | { ok: false; absence: AgentIdentityAbsence };

export function ensureAgentIdentityForPairing(
  stateDir: string,
  deps: { mint?: (stateDir: string) => unknown; exists?: (p: string) => boolean } = {},
): EnsureFirstPairIdentityResult {
  if (readAgentIdentityForHandover(stateDir)) return { ok: true, minted: false };
  // An identity FILE that cannot be handed over (encrypted, or unreadable) is still this agent's
  // identity: minting beside it would create a second one. Never mint over any identity file.
  const exists = (deps.exists ?? ((p: string) => fs.existsSync(p)));
  if (exists(path.join(stateDir, 'identity.json')) || exists(path.join(stateDir, 'threadline', 'identity.json'))) {
    return {
      ok: false,
      absence: {
        reason: 'inviter-identity-unreadable',
        detail: 'The machine you paired with has an agent identity it cannot hand over (it may be locked or damaged). '
          + 'Check it there with `instar identity status`, then pair again.',
      },
    };
  }
  const mint = deps.mint ?? ((dir: string) => new IdentityManager(dir).getOrCreate());
  try {
    mint(stateDir);
  } catch (err) {
    if (err instanceof IdentityNotProvisionedError) {
      return {
        ok: false,
        absence: {
          reason: 'inviter-mint-refused',
          detail: 'The machine you paired with has no agent identity, and it will not create one because '
            + 'it already lists another machine (creating one could split the agent in two). Give it the '
            + 'agent identity first (`instar identity adopt --from <machine>`, or on a truly standalone agent '
            + '`instar identity init --standalone --i-understand-peers-must-repin`), then pair again.',
        },
      };
    }
    return {
      ok: false,
      absence: {
        reason: 'inviter-mint-failed',
        detail: `The machine you paired with has no agent identity and could not create one: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  return readAgentIdentityForHandover(stateDir)
    ? { ok: true, minted: true }
    : { ok: false, absence: { reason: 'inviter-mint-failed', detail: 'The machine you paired with created an agent identity but could not read it back.' } };
}

/**
 * What the joiner prints when the pairing response carried no agent identity. A response that
 * names the reason is from a current inviter, so "older version" would be false (the incident
 * printed it between two machines on the same release). Only a response with no reason at all
 * is from an inviter that predates the handover.
 */
export function describeMissingAgentIdentity(absent: unknown): string {
  const a = absent as Partial<AgentIdentityAbsence> | null | undefined;
  if (a && typeof a.detail === 'string' && a.detail.trim()) {
    return `  ${a.detail.trim()}`;
  }
  return '  The machine you paired with is likely on an older version. Update it and re-pair.';
}

/**
 * The agent name the joiner should bind the identity handover to. The inviter seals the
 * envelope to ITS agent name; a joiner whose config never named the agent takes its name from
 * its folder, so a folder named anything else failed the handover (`transcript-agent-mismatch`).
 * A joiner whose config names the agent keeps that name (a real mismatch stays a refusal).
 * Returns the name to bind to (and, once the handover verifies, to write into the joiner's
 * config), or null to leave it alone.
 */
export function joinerAgentNameToAdopt(joinerFileConfig: { projectName?: unknown } | null, inviterAgentName: unknown): string | null {
  if (typeof inviterAgentName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(inviterAgentName) || inviterAgentName.includes('..')) return null;
  const explicit = joinerFileConfig?.projectName;
  if (typeof explicit === 'string' && explicit.trim()) return null;
  return inviterAgentName;
}
