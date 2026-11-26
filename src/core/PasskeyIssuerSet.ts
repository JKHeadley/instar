/**
 * PasskeyIssuerSet — the receiver-side EXPECTED-ISSUER set for `passkey-cell` mandates
 * (spec docs/specs/agent-held-google-passkey.md §3.3, FD21).
 *
 * WS5.2 trusts any registered peer as a mandate issuer and keeps no nonce ledger; passkey
 * authority is narrower. A machine accepts a passkey-cell mandate only from a machine on which
 * the operator has VERIFIED the dashboard PIN and which THIS machine has confirmed as an issuer:
 *   - a machine's own first local PIN check adds ITSELF (`local-pin`);
 *   - a PEER becomes an issuer only when the operator confirms it from this machine's OWN dashboard
 *     with a locally entered PIN (`operator-confirmed`) — never a peer-vouched authentication;
 *   - after that, existing issuers add/remove others with signed `issuer-add` / `issuer-remove` ops.
 * There is NO trust-on-first-use.
 *
 * Membership is re-checked when a mandate is verified (the identity components emit no events):
 * an issuer whose machine identity is `revoked` is refused and lazily removed; one that is
 * `pending`, `missing` or `unreadable` (or under a pending identity-recovery quarantine) is refused
 * but NOT removed — fail closed without forgetting.
 *
 * Machine-local BY DESIGN: `<stateDir>/state/passkey-issuers.json`, atomic writes, 0600. The
 * dashboard PIN never crosses the mesh; this file holds machine ids only.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PASSKEY_ISSUERS_FILE = path.join('state', 'passkey-issuers.json');

export type IssuerAddedVia = 'local-pin' | 'operator-confirmed' | 'issuer-add';

export interface PasskeyIssuer {
  /** The issuer's machine id — which is also its mesh fingerprint (the R4a issuerFingerprint). */
  machineId: string;
  addedAt: string;
  addedVia: IssuerAddedVia;
  /** For `issuer-add`: the machine id of the existing issuer that signed the op. */
  addedByIssuer?: string;
}

/** What the machine registry says about an issuer RIGHT NOW (checked at every verification). */
export type IssuerMachineStatus = 'active' | 'revoked' | 'pending' | 'missing' | 'unreadable';

export interface IssuerTrustVerdict {
  trusted: boolean;
  /** Named refusal for audit; absent when trusted. */
  reason?: 'not-an-issuer' | 'issuer-revoked' | 'issuer-pending' | 'issuer-missing' | 'issuer-unreadable' | 'issuer-quarantined';
  /** True when the check lazily removed a revoked issuer. */
  removed?: boolean;
}

interface IssuersFile { version: 1; issuers: PasskeyIssuer[] }

export interface PasskeyIssuerSetOptions {
  stateDir: string;
  /** This machine's id. */
  selfMachineId: string;
  /** Registry status of a machine; the ONLY removal signal is `revoked`. */
  machineStatus: (machineId: string) => IssuerMachineStatus;
  /** Optional: a pending identity-recovery quarantine for the machine ⇒ refuse (not removed). */
  quarantinePending?: (machineId: string) => boolean;
  now?: () => number;
}

export class PasskeyIssuerSet {
  private readonly file: string;
  private readonly self: string;
  private readonly machineStatus: (machineId: string) => IssuerMachineStatus;
  private readonly quarantinePending: (machineId: string) => boolean;
  private readonly now: () => number;

  constructor(opts: PasskeyIssuerSetOptions) {
    this.file = path.join(opts.stateDir, PASSKEY_ISSUERS_FILE);
    this.self = opts.selfMachineId;
    this.machineStatus = opts.machineStatus;
    this.quarantinePending = opts.quarantinePending ?? (() => false);
    this.now = opts.now ?? Date.now;
  }

  list(): PasskeyIssuer[] { return this.read().issuers.map((i) => ({ ...i })); }

  /** Confirmed PEER issuers (everyone but this machine). */
  peerIssuers(): PasskeyIssuer[] { return this.list().filter((i) => i.machineId !== this.self); }

  isListed(machineId: string): boolean { return this.read().issuers.some((i) => i.machineId === machineId); }

  /** A machine's own first local PIN check adds itself. Idempotent. */
  addSelfOnLocalPin(): { added: boolean } {
    return this.add({ machineId: this.self, addedVia: 'local-pin' });
  }

  /** Add an issuer. Idempotent on machineId (the first record wins; provenance is not rewritten). */
  add(input: { machineId: string; addedVia: IssuerAddedVia; addedByIssuer?: string }): { added: boolean } {
    const machineId = String(input.machineId ?? '').trim();
    if (!machineId) throw new Error('passkey-issuer-machine-id-required');
    const data = this.read();
    if (data.issuers.some((i) => i.machineId === machineId)) return { added: false };
    data.issuers.push({
      machineId, addedAt: new Date(this.now()).toISOString(), addedVia: input.addedVia,
      ...(input.addedByIssuer ? { addedByIssuer: input.addedByIssuer } : {}),
    });
    this.write(data);
    return { added: true };
  }

  remove(machineId: string): { removed: boolean } {
    const data = this.read();
    const before = data.issuers.length;
    data.issuers = data.issuers.filter((i) => i.machineId !== machineId);
    if (data.issuers.length === before) return { removed: false };
    this.write(data);
    return { removed: true };
  }

  /** The registry status the set would consult for a machine (used by issuer-add validation). */
  status(machineId: string): IssuerMachineStatus { return this.machineStatus(machineId); }

  /**
   * Is this machine a TRUSTED issuer right now? Listed AND currently `active` in the registry AND
   * not under a pending identity-recovery quarantine. `revoked` ⇒ refused + lazily removed; every
   * other non-active state ⇒ refused, kept (fail closed without forgetting).
   */
  verdict(machineId: string): IssuerTrustVerdict {
    if (!this.isListed(machineId)) return { trusted: false, reason: 'not-an-issuer' };
    const status = this.machineStatus(machineId);
    if (status === 'revoked') {
      const { removed } = this.remove(machineId);
      return { trusted: false, reason: 'issuer-revoked', removed };
    }
    if (status === 'pending') return { trusted: false, reason: 'issuer-pending' };
    if (status === 'missing') return { trusted: false, reason: 'issuer-missing' };
    if (status === 'unreadable') return { trusted: false, reason: 'issuer-unreadable' };
    if (this.quarantinePending(machineId)) return { trusted: false, reason: 'issuer-quarantined' };
    return { trusted: true };
  }

  private read(): IssuersFile {
    if (!fs.existsSync(this.file)) return { version: 1, issuers: [] };
    let parsed: Partial<IssuersFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<IssuersFile>;
    } catch (err) {
      throw new Error(`passkey-issuers-unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.issuers)) throw new Error('passkey-issuers-unreadable: unexpected shape');
    return { version: 1, issuers: parsed.issuers.filter((i) => i && typeof i.machineId === 'string') };
  }

  private write(data: IssuersFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
