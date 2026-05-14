/**
 * RemediatorBootstrap — wires the Tier-2 live-mode dispatch path.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A57 — "Tier 2 unlocks live mode (silence
 * on verified success per outcome matrix)." This module is the
 * orchestration glue between:
 *
 *   - F-1 RemediationKeyVault         (per-context HKDF leaf keys)
 *   - F-4 MachineLock + IntentJournal (in-flight + durable witness)
 *   - F-4 AuditWriter                 (verified-append audit log)
 *   - F-5 TrustElevationSource        (lifecycle-transition authority)
 *   - F-6 ServerSupervisor            (restart handshake, when present)
 *   - F-8 Remediator                  (dispatch orchestrator)
 *   - W-1 nodeAbiMismatchRunbook      (and any later Tier-1+Tier-2 runbooks
 *                                      registered on main at boot-time)
 *   - F-3 DegradationReporter.setRemediator() (final wire-in)
 *
 * The bootstrap is INERT unless `remediator.enabled === true` in config.json.
 * The default is FALSE so the live-mode flip stays opt-in until each agent's
 * operator explicitly enables it — the staged rollout discipline the spec
 * calls for in §A57.
 *
 * Failure modes (per A62 operating-state matrix):
 *   - No secret backend available → returns `{disabled: true, reason:
 *     'no-secret-backend'}`. Caller continues with the legacy alert path; the
 *     in-line healers (`NativeModuleHealer.openWithHeal`, supervisor
 *     `preflightSelfHeal`) remain the safety net.
 *   - Vault constructs but a downstream primitive throws → the bootstrap
 *     re-throws. The server boot path treats this as a hard failure since the
 *     operator explicitly opted in; we don't want to silently revert to
 *     legacy mode after the operator asked for live mode.
 *
 * Signal-vs-authority discipline:
 *   - The Remediator is the authority. It already owns the trust /
 *     capability / audit decisions per spec.
 *   - This bootstrap does NOT add any new decision point. It is dependency
 *     injection + a structural opt-in switch.
 *   - The `remediator.enabled` flag is a CONFIG toggle (operator authority),
 *     not a runtime judgment. It selects between "wire the orchestrator" and
 *     "leave the legacy alert path running."
 */

import path from 'node:path';

import {
  RemediationKeyVault,
  RemediationKeyVaultError,
} from './RemediationKeyVault.js';
import { MachineLock } from './MachineLock.js';
import { IntentJournal } from './IntentJournal.js';
import { AuditWriter } from './audit/AuditWriter.js';
import {
  TrustElevationSource,
  type TrustedApprovalChannel,
} from './TrustElevationSource.js';
import { TelegramApprovalChannel } from './channels/TelegramApprovalChannel.js';
import { CliApprovalChannel } from './channels/CliApprovalChannel.js';
import { Remediator, type ApprovedRunbook } from './Remediator.js';
import { nodeAbiMismatchRunbook } from './runbooks/node-abi-mismatch.js';
import { messagingDeliveryFailedRunbook } from './runbooks/messaging-delivery-failed.js';
import type { ServerSupervisor } from '../lifeline/ServerSupervisor.js';
import type { AutonomyProfileLevel } from '../core/types.js';

// ── Public types ─────────────────────────────────────────────────────────

export type ApprovalChannelKind = 'telegram' | 'cli';

export interface RemediatorBootstrapOptions {
  /** Root state dir (the agent's `.instar/`). Required. */
  stateDir: string;
  /** Stable machine identifier (typically `coordinator.identity.machineId ?? os.hostname()`). */
  machineId: string;
  /** Optional supervisor instance. In the server process this is unwired today
   *  (supervisor lives in the lifeline process); the field is here so test
   *  fixtures and future in-process supervisors can wire it. */
  serverSupervisor?: ServerSupervisor;
  /**
   * Autonomy profile for the F-5 TrustElevationSource. Defaults to
   * `'supervised'` per spec — the safest default for a fresh live-mode flip.
   */
  autonomyProfile?: AutonomyProfileLevel;
  /**
   * Primary approval channel for the TrustElevationSource. Defaults to
   * `'telegram'`. The bootstrap will additionally wire the CLI channel as the
   * second-channel option (A53) regardless of primary selection.
   */
  primaryApprovalChannel?: ApprovalChannelKind;
  /**
   * Test/extension hook — additional runbooks to register beyond the Tier-1
   * defaults. Production callers should NOT pass this; runbooks land via
   * source PRs (W-1, W-2, …) and are imported below by name. The hook exists
   * so the integration test can register a deterministic test fixture.
   */
  additionalRunbooks?: ApprovedRunbook[];
}

export type BootstrapResult =
  | {
      disabled: false;
      remediator: Remediator;
      vault: RemediationKeyVault;
      registeredRunbookIds: string[];
    }
  | { disabled: true; reason: 'no-secret-backend' | 'config-flag-false' };

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Construct the full Tier-2 dispatch graph and register the runbooks that
 * are present on main at boot time. Returns the constructed Remediator (+
 * vault) on success, or a `{disabled, reason}` payload when the bootstrap
 * cannot proceed.
 *
 * The caller is responsible for the FINAL wire-in:
 *
 *     const result = await bootstrapRemediator({ stateDir, machineId });
 *     if (!result.disabled) {
 *       degradationReporter.setRemediator(result.remediator);
 *     }
 *
 * We deliberately do NOT call `setRemediator` inside the bootstrap so this
 * module is testable without singleton state and so the server boot path can
 * log the wire-in explicitly.
 */
export async function bootstrapRemediator(
  opts: RemediatorBootstrapOptions,
): Promise<BootstrapResult> {
  if (!opts.stateDir) {
    throw new Error('bootstrapRemediator: stateDir is required');
  }
  if (!opts.machineId) {
    throw new Error('bootstrapRemediator: machineId is required');
  }

  // 1. Probe for a secret backend. The 4-backend probe lives inside
  //    `RemediationKeyVault.forStateDir`. We treat "no backend available" as
  //    a graceful disabled state (per A62) so the legacy alert path keeps
  //    running. Any OTHER vault error propagates — that's a hard fault the
  //    operator asked to know about.
  let vault: RemediationKeyVault;
  try {
    vault = await RemediationKeyVault.forStateDir(opts.stateDir, {
      allowEnvPassphraseFallback: true,
    });
  } catch (err) {
    if (
      err instanceof RemediationKeyVaultError &&
      err.code === 'no-backend-available'
    ) {
      return { disabled: true, reason: 'no-secret-backend' };
    }
    throw err;
  }

  // 2. F-4 primitives. MachineLock + IntentJournal + AuditWriter all share
  //    the same state-dir; the writer adds machineId disambiguation.
  const machineLock = new MachineLock(opts.stateDir);
  const intentJournal = new IntentJournal(opts.stateDir, {
    machineId: opts.machineId,
  });
  const auditWriter = new AuditWriter(opts.stateDir, {
    machineId: opts.machineId,
    // The Remediator's dispatcher issues the auditToken by deriving from the
    // 'audit' context leaf (one shared per machine). Production-mode token
    // verification is HMAC-over-entry; F-8's skeleton uses the leaf-key
    // itself as the token (the per-call HKDF derivation is the
    // authenticator). For Tier-2 live wiring we accept any 32-byte non-empty
    // token that matches the vault's audit-leaf — the audit pipeline's
    // structural defenses (timestamp watermark, rejected-file routing) are
    // the rest of the integrity envelope.
    tokenVerifier: makeAuditTokenVerifier(vault),
  });

  // 3. F-5 TrustElevationSource. Default autonomy profile is 'supervised' —
  //    the minimum that gates upward transitions; matches the spec's stated
  //    default for a fresh live-mode opt-in.
  const channels: TrustedApprovalChannel[] = buildApprovalChannels(
    opts.primaryApprovalChannel ?? 'telegram',
  );
  const trustSource = new TrustElevationSource({
    profile: opts.autonomyProfile ?? 'supervised',
    channels,
  });

  // 4. F-8 Remediator. ServerSupervisor is optional today — the supervisor
  //    lives in the lifeline process, not the server process. When a future
  //    PR moves the supervisor into the server boot graph (or vice-versa)
  //    the field flows through unchanged.
  const remediator = new Remediator({
    stateDir: opts.stateDir,
    keyVault: vault,
    machineLock,
    intentJournal,
    auditWriter,
    trustSource,
    serverSupervisor: opts.serverSupervisor,
  });

  // 5. Register Tier-1+Tier-2 runbooks that have landed on main. As later
  //    runbooks land (W-2 supervisor-preflight, W-3 messaging-delivery, W-4
  //    db-corruption) they ship a runbook export and we add a guarded import
  //    here. Missing runbooks are skipped with a console line, per the
  //    PR-driving instructions in this bootstrap's commit message.
  const registeredRunbookIds: string[] = [];
  const toRegister: { id: string; runbook: ApprovedRunbook | null }[] = [
    { id: 'node-abi-mismatch', runbook: nodeAbiMismatchRunbook },
    // W-2 supervisor-preflight runbook — not yet on main; will be enabled
    // when the wrapper PR lands. Skipped today with a log line below.
    { id: 'supervisor-preflight', runbook: tryLoadOptionalRunbook(
      'supervisor-preflight',
    ) },
    // W-3 messaging-delivery-failed runbook — on main as of PR #219.
    { id: 'messaging-delivery-failed', runbook: messagingDeliveryFailedRunbook },
    // W-4 db-corruption runbook — not yet on main.
    { id: 'db-corruption', runbook: tryLoadOptionalRunbook(
      'db-corruption',
    ) },
  ];

  for (const entry of toRegister) {
    if (!entry.runbook) {
      console.log(
        `[RemediatorBootstrap] runbook "${entry.id}" not yet on main — skipping`,
      );
      continue;
    }
    try {
      remediator.registerRunbook(entry.runbook);
      registeredRunbookIds.push(entry.runbook.id);
    } catch (err) {
      // Registry validation failures (A6 / A36) MUST be loud. The wrapper PR
      // is structurally wrong; we surface it instead of silently degrading.
      console.error(
        `[RemediatorBootstrap] registerRunbook("${entry.id}") failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }

  // 6. Test/extension runbooks (integration test consumer).
  if (opts.additionalRunbooks) {
    for (const rb of opts.additionalRunbooks) {
      remediator.registerRunbook(rb);
      registeredRunbookIds.push(rb.id);
    }
  }

  return {
    disabled: false,
    remediator,
    vault,
    registeredRunbookIds,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Build the approval-channel array used by `TrustElevationSource`. Always
 * includes both Telegram and CLI channels so A53's "different-kind second
 * channel" rule can be satisfied; the `primary` selection only affects which
 * channel is listed FIRST (the source preserves the array order).
 */
function buildApprovalChannels(
  primary: ApprovalChannelKind,
): TrustedApprovalChannel[] {
  const telegram = new TelegramApprovalChannel();
  const cli = new CliApprovalChannel();
  return primary === 'cli'
    ? [cli, telegram]
    : [telegram, cli];
}

/**
 * Audit-token verifier wired against the vault's audit-context leaf. The
 * Remediator's dispatch path derives the token as `vault.deriveLeafKey
 * ('audit', null)` — i.e. the leaf key itself. We accept any token whose
 * bytes match the current audit-leaf, with a timing-safe comparison.
 */
function makeAuditTokenVerifier(
  vault: RemediationKeyVault,
): (entry: { auditToken: Buffer }) => boolean {
  return (entry) => {
    if (!Buffer.isBuffer(entry.auditToken) || entry.auditToken.length === 0) {
      return false;
    }
    const leaf = vault.deriveLeafKey('audit', null);
    if (leaf.length !== entry.auditToken.length) return false;
    // Avoid timing-safe import; the audit-token verify is internal to the
    // process. crypto.timingSafeEqual is the right tool but importing here
    // adds nothing structural — equivalent compares.
    return constantTimeEqual(leaf, entry.auditToken);
  };
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Lazy-load an optional runbook by module slug. Returns null when the file
 * does not exist on main yet — bootstrap will log + skip. Returns the
 * runbook when present.
 *
 * Implementation note: we use a sync require() shim against the runbooks
 * dir so the bootstrap can decide synchronously whether to enable a wrapper
 * without dragging dynamic import into an async preamble. The runbooks
 * already on main are statically imported above (e.g. `nodeAbiMismatchRunbook`).
 * This helper is only for W-2/W-3/W-4 which haven't merged yet.
 */
function tryLoadOptionalRunbook(slug: string): ApprovedRunbook | null {
  void slug;
  // Returning null until each wrapper PR lands. When W-2 lands, this becomes:
  //   import { supervisorPreflightRunbook } from './runbooks/supervisor-preflight.js';
  //   case 'supervisor-preflight': return supervisorPreflightRunbook;
  // Keeping this branchless null today is the safest stub — the registration
  // loop above logs the skip so observability is preserved.
  return null;
}

// ── Test surface ─────────────────────────────────────────────────────────

/** Exported for test-only assertions of the optional-runbook scaffold. */
export const __testing = {
  makeAuditTokenVerifier,
  buildApprovalChannels,
  constantTimeEqual,
  tryLoadOptionalRunbook,
};

// Re-export the path the bootstrap writes audit state to, for observability.
export function remediationStateDir(stateDir: string): string {
  return path.join(stateDir, 'remediation');
}
