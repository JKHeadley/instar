/**
 * PairingSessionStore — durably persist the active pairing session so the
 * running server's `/api/pair` handler can validate a join request's code.
 *
 * WHY THIS EXISTS (found 2026-05-29 during the session-pool hardware bring-up):
 * `instar pair` runs as a SEPARATE process from the server. It generated a
 * pairing code, printed it, and assigned the session to an UNUSED `_pairingSession`
 * — never persisting it. So the running server had no code to validate against,
 * which is why `/api/pair` was "signal-only" and pairing could only complete via
 * interactive SAS confirmation on both screens. An active-active session pool
 * can't require a human to eyeball symbols per machine, so (per the operator's
 * "Proceed with A" decision) pairing becomes code-authenticated + non-interactive:
 * `instar pair` persists the session here, and `/api/pair` loads + validates it.
 *
 * Only the validation-relevant fields are persisted (NOT the ephemeral X25519
 * private key, which is a `KeyObject` and is not needed for code-based auth).
 * The file is written 0600 — the pairing code is a short-lived shared secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PairingSession } from './PairingProtocol.js';

/** The JSON-serializable subset of a PairingSession needed to validate a code. */
export type StoredPairingSession = Omit<PairingSession, 'ephemeralKeys'>;

export class PairingSessionStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'machine', 'pairing-session.json');
  }

  /** Persist (or overwrite) the active pairing session, secret-permissioned. */
  save(session: StoredPairingSession): void {
    const slim: StoredPairingSession = {
      code: session.code,
      createdAt: session.createdAt,
      failedAttempts: session.failedAttempts,
      maxAttempts: session.maxAttempts,
      expiryMs: session.expiryMs,
      consumed: session.consumed,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(slim, null, 2), { mode: 0o600 });
  }

  /** Load the active pairing session, or null if none / unreadable. */
  load(): StoredPairingSession | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoredPairingSession;
      if (!parsed || typeof parsed.code !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
