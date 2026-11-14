/**
 * Double opt-in and proof-mail bounds (docs/specs/backup-email-sending.md, Owner-only by construction; Two checks).
 *
 * The proof mail carries a six-digit code; in shapes A and C the row is working only when the owner enters it on
 * the confirm page. The nonce is keyed with this machine's identity key, bound to the recipient hash, expires in
 * 30 minutes, and allows five wrong entries. Its record and attempt count are durable, so a restart does not reset
 * them. Proof mails to a not-yet-confirmed recipient are bounded to three a day (shape A's signup mail counts) and
 * twenty in all; one passing proof per credential version.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OPT_IN_MAX_ATTEMPTS = 5;
export const OPT_IN_EXPIRY_MS_DEFAULT = 30 * 60_000;
export const OPT_IN_EXPIRY_MS_FLOOR = 24 * 60 * 60_000;
export const PROOF_MAILS_PER_DAY = 3;
export const PROOF_MAILS_TOTAL = 20;
export const PROOF_RETRY_GAP_MS = 10 * 60_000;
export const PROOF_RETRIES_SHAPE_B = 3;

interface NonceRecord {
  recipientHash: string;
  codeMac: string;
  mintedAt: number;
  expiresAt: number;
  attempts: number;
  machineId: string;
}

interface ProofRecord {
  result: 'pass' | 'fail' | 'unknown';
  at: number;
  delivery?: string;
  providerId?: string;
}

interface OptInState {
  nonce?: NonceRecord;
  /** The recipient hash the owner confirmed with a code. */
  confirmed?: { recipientHash: string; at: number };
  /** Proof mails to an unconfirmed recipient, per recipient hash. */
  mails?: Record<string, { total: number; days: Record<string, number> }>;
  /** Proof results by credential version. */
  proofs?: Record<string, ProofRecord & { tries: number }>;
}

export type CodeCheck = 'ok' | 'wrong' | 'expired' | 'locked' | 'none' | 'recipient-changed';

export class EmailOptInStore {
  private readonly file: string;

  constructor(private readonly opts: { stateDir: string; machineId: string; macKey: string | Buffer; now?: () => number; expiryMs?: number }) {
    this.file = path.join(opts.stateDir, 'state', 'email-opt-in.json');
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private expiryMs(): number {
    const v = this.opts.expiryMs ?? OPT_IN_EXPIRY_MS_DEFAULT;
    return Math.min(Math.max(60_000, v), OPT_IN_EXPIRY_MS_FLOOR);
  }

  private read(): OptInState {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as OptInState;
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {}; // @silent-fallback-ok — no file yet is no opt-in yet; the row stays unproven
    }
  }

  private write(state: OptInState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private mac(recipientHash: string, code: string): string {
    return crypto.createHmac('sha256', this.opts.macKey).update(`email-opt-in\u0000${recipientHash}\u0000${code}`).digest('hex');
  }

  /** Mints a fresh code for this recipient, replacing any earlier one. The code itself is returned once, for the proof mail. */
  mint(recipientHash: string): { code: string; expiresAt: number } {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const state = this.read();
    const mintedAt = this.now();
    state.nonce = { recipientHash, codeMac: this.mac(recipientHash, code), mintedAt, expiresAt: mintedAt + this.expiryMs(), attempts: 0, machineId: this.opts.machineId };
    this.write(state);
    return { code, expiresAt: state.nonce.expiresAt };
  }

  /** Checks an entered code. Five misses or expiry void the nonce only: the grant and the credential stand. */
  check(recipientHash: string, code: unknown): CodeCheck {
    const state = this.read();
    const n = state.nonce;
    if (!n) return 'none';
    if (n.recipientHash !== recipientHash) return 'recipient-changed';
    if (n.attempts >= OPT_IN_MAX_ATTEMPTS) return 'locked';
    if (this.now() > n.expiresAt) return 'expired';
    const entered = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
    const ok = /^\d{6}$/.test(entered) && crypto.timingSafeEqual(Buffer.from(this.mac(recipientHash, entered), 'hex'), Buffer.from(n.codeMac, 'hex'));
    if (!ok) {
      n.attempts += 1;
      this.write(state);
      return n.attempts >= OPT_IN_MAX_ATTEMPTS ? 'locked' : 'wrong';
    }
    delete state.nonce;
    state.confirmed = { recipientHash, at: this.now() };
    this.write(state);
    return 'ok';
  }

  /** True when the owner entered the code for exactly this recipient. */
  isConfirmed(recipientHash: string): boolean {
    return this.read().confirmed?.recipientHash === recipientHash;
  }

  /** A waiting code for this recipient: not expired and not locked. */
  awaitingCode(recipientHash: string): boolean {
    const n = this.read().nonce;
    return !!n && n.recipientHash === recipientHash && n.attempts < OPT_IN_MAX_ATTEMPTS && this.now() <= n.expiresAt;
  }

  /** Proof mails sent to this (unconfirmed) recipient today and in all. */
  mailsSent(recipientHash: string, day: string): { today: number; total: number } {
    const m = this.read().mails?.[recipientHash];
    return { today: m?.days?.[day] ?? 0, total: m?.total ?? 0 };
  }

  /** True when one more mail to an unconfirmed recipient fits today's and the total bound. */
  mayMail(recipientHash: string, day: string): boolean {
    const { today, total } = this.mailsSent(recipientHash, day);
    return today < PROOF_MAILS_PER_DAY && total < PROOF_MAILS_TOTAL;
  }

  /** Counts a mail to an unconfirmed recipient (a proof mail, or shape A's signup mail). */
  countMail(recipientHash: string, day: string): void {
    const state = this.read();
    const mails = state.mails ?? {};
    const m = mails[recipientHash] ?? { total: 0, days: {} };
    m.total += 1;
    m.days[day] = (m.days[day] ?? 0) + 1;
    // Only the last week of days matters; older days are pruned.
    for (const d of Object.keys(m.days).sort().slice(0, -7)) delete m.days[d];
    mails[recipientHash] = m;
    state.mails = mails;
    this.write(state);
  }

  proof(version: string): (ProofRecord & { tries: number }) | null {
    return this.read().proofs?.[version] ?? null;
  }

  recordProof(version: string, rec: ProofRecord): void {
    const state = this.read();
    const proofs = state.proofs ?? {};
    const prev = proofs[version];
    proofs[version] = { ...rec, tries: (prev?.tries ?? 0) + 1 };
    // Only the newest few versions matter.
    const keep = Object.entries(proofs).sort((a, b) => b[1].at - a[1].at).slice(0, 8);
    state.proofs = Object.fromEntries(keep);
    this.write(state);
  }

  /** Clears everything (a switch-off). */
  clear(): void {
    this.write({});
  }
}
