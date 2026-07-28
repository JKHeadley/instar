/**
 * DemoChannelRegistry — the §5.3 isolation backbone of the live-user-channel-proof
 * standard (docs/specs/live-user-channel-proof-standard.md §5.3 "Demo Channel
 * Isolation").
 *
 * A volatile / permission / dangerous live-test scenario must NEVER touch the live
 * operator channel — it runs only on a registered DEMO channel (a throwaway Slack
 * workspace, a demo Telegram group). The LiveTestHarness enforces this structurally
 * by calling `isDemoChannel(surface, channelId)` and refusing the whole run (a throw,
 * not a convention) if a non-safe scenario points at a channel this registry does not
 * vouch for.
 *
 * The bindings are SIGNED and read once. A binding set that fails signature
 * verification (tampered, unsigned, wrong signer) is FAIL-CLOSED: every channel
 * resolves to NOT-a-demo-channel, so the harness's §5.3 guard refuses every volatile
 * scenario rather than trusting an unverified "this is a safe demo channel" claim.
 * Fail-closed is the safe direction here — the cost of a false "not demo" is a refused
 * test; the cost of a false "is demo" is a destructive scenario on the live channel.
 *
 * This module is pure/injectable: it takes the raw bindings document + a `verify`
 * function (Ed25519, same signer surface the LiveTestArtifactStore uses) so it is
 * unit-testable with no filesystem or crypto host.
 */

import type { Surface } from './LiveTestArtifactStore.js';

/** One registered demo channel. `workspaceId` is Slack-only (the demo workspace). */
export interface DemoChannelBinding {
  surface: Surface;
  /** Slack channel id, Telegram chat/topic id (as a string), or dashboard id. */
  channelId: string;
  /** Slack workspace / team id — REQUIRED for slack, ignored otherwise. */
  workspaceId?: string;
  /** Human label for audit (e.g. "SageMind Live Test"). */
  label?: string;
}

/** The on-disk, signed bindings document. */
export interface DemoChannelBindingsDoc {
  version: 1;
  /** The machine that authored these bindings (audit only). */
  machineId: string;
  bindings: DemoChannelBinding[];
  signedAt: string;
  /** Ed25519 signature over the canonical payload (see canonicalBindingsPayload). */
  signature: string;
}

export interface DemoChannelRegistryDeps {
  /** The raw bindings document (e.g. parsed from state/demo-channel-bindings.json), or null when none exist. */
  doc: DemoChannelBindingsDoc | null;
  /** Verify a signature over a canonical payload string. Returns true iff valid. */
  verify: (payload: string, signature: string) => boolean;
  logger?: (m: string) => void;
}

/**
 * The exact bytes the signature covers. Stable, order-independent across the binding
 * LIST (sorted) so a re-serialization can't change the signed payload, but the
 * signature is otherwise over the full meaningful content (version + machineId +
 * signedAt + every binding field). Any field change invalidates the signature.
 */
export function canonicalBindingsPayload(doc: Omit<DemoChannelBindingsDoc, 'signature'>): string {
  // Each binding is encoded as an ORDERED JSON tuple, NOT a delimiter-free
  // concatenation. A concatenation like `${surface}${channelId}${workspaceId}` is
  // ambiguous at field boundaries ({channelId:'C1',workspaceId:'W2'} vs
  // {channelId:'C1W2'} would serialize identically and share one signature — a
  // real bypass that promotes an unvouched channelId to a demo channel). A JSON
  // tuple makes every field boundary explicit and distinguishes an absent field
  // (null) from a present empty string (''), so one signature covers exactly one
  // binding set.
  const norm = (b: DemoChannelBinding) =>
    JSON.stringify([b.surface, b.channelId, b.workspaceId ?? null, b.label ?? null]);
  const lines = [...doc.bindings].map(norm).sort();
  return [
    `v=${doc.version}`,
    `machine=${doc.machineId}`,
    `signedAt=${doc.signedAt}`,
    ...lines.map((l) => `b=${l}`),
  ].join('\n');
}

export class DemoChannelRegistry {
  private readonly verified: boolean;
  private readonly set: Set<string>;
  private readonly d: DemoChannelRegistryDeps;

  constructor(deps: DemoChannelRegistryDeps) {
    this.d = deps;
    const { doc } = deps;
    if (!doc) {
      // No bindings at all is a legitimate state (safe-only test runs). It is NOT an
      // error — it simply means there are zero demo channels, so isDemoChannel is
      // always false and only safe scenarios can run.
      this.verified = false;
      this.set = new Set();
      return;
    }
    const { signature, ...unsigned } = doc;
    let ok = false;
    try {
      ok = this.d.verify(canonicalBindingsPayload(unsigned), signature);
    } catch (err) {
      this.log(`verify threw (treating as unverified): ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
    }
    this.verified = ok;
    if (!ok) {
      // Fail-closed: a present-but-unverifiable bindings doc grants ZERO demo channels.
      this.log(`bindings present but signature INVALID — fail-closed (0 demo channels; volatile scenarios will be refused)`);
      this.set = new Set();
      return;
    }
    this.set = new Set(doc.bindings.map((b) => this.key(b.surface, b.channelId)));
  }

  private key(surface: Surface, channelId: string): string {
    // Unambiguous (JSON tuple) for the same reason canonicalBindingsPayload uses one —
    // so a lookup key can never alias across the surface/channelId boundary. (Safe
    // today since surface is a closed enum, but encoded explicitly for defense-in-depth.)
    return JSON.stringify([surface, channelId]);
  }
  private log(m: string): void { this.d.logger?.(`[demo-channel-registry] ${m}`); }

  /** True iff (surface, channelId) is a verified, registered demo channel. */
  isDemoChannel(surface: Surface, channelId: string): boolean {
    return this.set.has(this.key(surface, channelId));
  }

  /** Whether a present bindings doc verified (false when none exist OR signature failed). */
  get isVerified(): boolean { return this.verified; }

  /** Count of registered demo channels (0 when unverified/absent). */
  get size(): number { return this.set.size; }
}
