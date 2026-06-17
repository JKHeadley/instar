/**
 * WS5.2 R4a — durable store of cross-machine-DELIVERED account-follow-me mandates.
 *
 * THE ONE-DASHBOARD PROBLEM (operator feedback, load-bearing): the operator has ONE dashboard.
 * An account-follow-me enrollment is acted on by the TARGET machine, but a mandate is issued
 * (PIN-gated) on the operator's machine. A mandate issued on the laptop has LAPTOP authorship
 * (a symmetric HMAC over the laptop's per-machine authToken, §3.1a) and will NOT pass the target's
 * `MandateStore.verifyAuthorship` — by design. So the operator dashboard issues the mandate and
 * DELIVERS it (the R4a-signed `PortableMandate`) to the target over the mesh, where it is verified
 * via the asymmetric issuance signature against the target's REGISTERED operator-machine key.
 *
 * This store is where a target persists a delivered+verified mandate. It retains the FULL
 * `PortableMandate` (the mandate AND its asymmetric issuance signature), keyed by mandate id, so
 * the enroll-start route can RE-VERIFY at point-of-use (defense-in-depth — never trust a stored
 * flag blindly; the §3.1a HMAC proof is local-only and cannot ground a delivered mandate, so the
 * R4a signature is the standing proof of authority). It also records the authenticated operator
 * machine that delivered it (the mesh-authenticated `env.sender`) so the re-verify at use time
 * binds to the SAME trust anchor.
 *
 * Trust boundary (same root as MandateStore): integrity of the on-disk file against a LOCAL-write
 * attacker is the baseline (T12, out of scope). The R4a signature stops a forged/edited delivered
 * mandate from a hostile peer — local-file tamper of server-managed state is the baseline boundary.
 *
 * Pure file-state, no DB (file-based-state design decision). Mirrors MandateStore's read/write
 * shape. WS5.2 one-dashboard cross-machine mandate delivery.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PortableMandate } from './AccountFollowMeMandateBridge.js';

/** A delivered mandate as persisted on the target: the portable bundle + its delivery provenance. */
export interface DeliveredMandateRecord {
  /** The mandate id (the store key). */
  id: string;
  /** The full R4a-signed bundle — retained so the bounds + provenance + signature survive for
   *  point-of-use re-verification. */
  portable: PortableMandate;
  /** The mesh-AUTHENTICATED operator machine that delivered it (env.sender) — the trust anchor
   *  the enroll-start re-verify must bind to. NEVER a name from the payload. */
  deliveredBy: string;
  /** The REGISTERED operator-machine Ed25519 public key (PEM) the R4a signature verified against at
   *  delivery — recorded so the point-of-use re-verify re-binds to the SAME anchor WITHOUT needing a
   *  peer-key lookup. This is a PUBLIC key (never a secret); persisting it is safe. */
  operatorPublicKeyPem: string;
  /** When the target accepted+persisted it (ISO). */
  deliveredAt: string;
}

export interface DeliveredMandateStoreDeps {
  /** Absolute path to the delivered-mandates JSON file. */
  filePath: string;
  now?: () => number;
}

export class DeliveredMandateStore {
  private readonly d: DeliveredMandateStoreDeps;
  constructor(deps: DeliveredMandateStoreDeps) {
    this.d = deps;
  }

  private nowIso(): string {
    return new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
  }

  private readAll(): DeliveredMandateRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as DeliveredMandateRecord[]) : [];
    } catch {
      // @silent-fallback-ok — file may not exist yet; an empty store is DENY-BY-DEFAULT (the safe state).
      return [];
    }
  }

  private writeAll(records: DeliveredMandateRecord[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(records, null, 2));
  }

  /**
   * Persist a delivered+verified mandate (called by the mesh handler ONLY after `acceptDeliveredMandate`
   * verified the R4a signature). `deliveredBy` is the mesh-AUTHENTICATED sender, NOT a payload name.
   * Idempotent by mandate id (a redelivery overwrites with the latest provenance).
   */
  put(portable: PortableMandate, deliveredBy: string, operatorPublicKeyPem: string): DeliveredMandateRecord {
    const id = portable.mandate.id;
    const record: DeliveredMandateRecord = {
      id, portable, deliveredBy, operatorPublicKeyPem, deliveredAt: this.nowIso(),
    };
    const all = this.readAll().filter((r) => r.id !== id);
    all.push(record);
    this.writeAll(all);
    return record;
  }

  get(id: string): DeliveredMandateRecord | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  list(): DeliveredMandateRecord[] {
    return this.readAll();
  }

  /** Remove a delivered mandate (e.g. on revocation). Idempotent. */
  remove(id: string): void {
    const all = this.readAll();
    const next = all.filter((r) => r.id !== id);
    if (next.length !== all.length) this.writeAll(next);
  }
}
