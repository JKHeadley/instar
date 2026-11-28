/**
 * The Chrome version gate (spec docs/specs/agent-held-google-passkey.md §2 "Chrome version gate").
 *
 * The whole passkey path depends on Chrome's DevTools virtual authenticator behaving as measured.
 * So on each machine, whenever the installed Chrome MAJOR version differs from the last verified
 * one, passkey use is refused (`passkey-chrome-unverified`) until the local WebAuthn fixture
 * self-test passes on that major: mint a resident credential in one fresh browser, export it,
 * inject it into a SECOND fresh browser and assert with it. The result is recorded per
 * (machine, Chrome major) and re-run only on a version change or an explicit recheck.
 *
 * Signal, stated honestly (P20): a pass proves only that THIS Chrome's virtual authenticator can
 * hold, export, re-inject and assert a credential against a local relying party. It does not prove
 * Google accepts it; the first passkey use on a newly verified major is a single cold proof (§2),
 * which is the caller's job. An unreadable version or a self-test that cannot run reads `unchecked`
 * and refuses — never a flattering `passed`.
 *
 * Machine-local by design (physical-credential-locality: the Chrome binary and its authenticator
 * are on this machine's disk); the file is never replicated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import type { PasskeyChromeGate } from './PasskeyRepairAdmission.js';

export const PASSKEY_CHROME_GATE_FILE = path.join('state', 'passkey-chrome-gate.json');

export interface PasskeyChromeGateRecord {
  chromeMajor: number;
  result: 'passed' | 'failed';
  checkedAt: string;
  /** A short machine-readable reason on failure (never page text or credential material). */
  reason: string | null;
}

/** Parse a `--version` line such as "Google Chrome 131.0.6778.86" or "Chromium 120.0.1". */
export function parseChromeMajor(versionLine: string): number | null {
  const m = /(\d+)\.\d+(?:\.\d+)*/.exec(versionLine);
  if (!m) return null;
  const major = Number(m[1]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** The installed Chrome's major version, or null when it cannot be read. */
export function readChromeMajor(executable: string | null, run: (exe: string) => string = defaultVersionRun): number | null {
  if (!executable) return null;
  try { return parseChromeMajor(run(executable)); } catch { return null; } // @silent-fallback-ok — unreadable version reads null, which refuses passkey use (unchecked)
}

function defaultVersionRun(exe: string): string {
  return withSyncOp(() => execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }));
}

export class PasskeyChromeGateStore {
  private readonly file: string;
  constructor(opts: { stateDir: string }) { this.file = path.join(opts.stateDir, PASSKEY_CHROME_GATE_FILE); }

  read(): PasskeyChromeGateRecord | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PasskeyChromeGateRecord>;
      if (typeof r.chromeMajor !== 'number' || (r.result !== 'passed' && r.result !== 'failed') || typeof r.checkedAt !== 'string') return null;
      return { chromeMajor: r.chromeMajor, result: r.result, checkedAt: r.checkedAt, reason: typeof r.reason === 'string' ? r.reason.slice(0, 120) : null };
    } catch {
      // @silent-fallback-ok — an unreadable record reads as never-checked, which refuses passkey use
      return null;
    }
  }

  write(record: PasskeyChromeGateRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** When the CURRENT major passed (ms), or null when it has not passed. */
  verifiedAtMs(currentMajor: number | null): number | null {
    if (currentMajor === null) return null;
    const r = this.read();
    if (!r || r.chromeMajor !== currentMajor || r.result !== 'passed') return null;
    const at = Date.parse(r.checkedAt);
    return Number.isFinite(at) ? at : null;
  }

  /** The gate for the CURRENT Chrome major: a record for a different major reads `unchecked`. */
  gateFor(currentMajor: number | null): PasskeyChromeGate {
    if (currentMajor === null) return 'unchecked';
    const r = this.read();
    if (!r || r.chromeMajor !== currentMajor) return 'unchecked';
    return r.result;
  }
}

/** The two browser operations the self-test needs, so it is testable without Chrome. */
export interface ChromeGateBrowser {
  open(url: string): Promise<void>;
  runInPage<T>(expression: string): Promise<T>;
  exportCredentials(): Promise<unknown[]>;
  addCredential(credential: unknown): Promise<void>;
  observedAssertion(credentialId: string): boolean;
  close(): Promise<void>;
}

export interface ChromeGateSelfTestDeps {
  /** A fresh, empty, passkey-mode browser per call. */
  newBrowser: () => ChromeGateBrowser | Promise<ChromeGateBrowser>;
  /** The local fixture's holder origin (from startPasskeyFixture). */
  holderOrigin: string;
}

/**
 * Mint → export → re-inject in a second fresh browser → assert. Returns a reason on failure.
 * Both browsers are always closed.
 */
export type ChromeGateSelfTestResult = { passed: true } | { passed: false; reason: string; transient?: boolean };

export async function runChromeGateSelfTest(deps: ChromeGateSelfTestDeps): Promise<ChromeGateSelfTestResult> {
  const opened: ChromeGateBrowser[] = [];
  const fresh = async () => { const b = await deps.newBrowser(); opened.push(b); await b.open(`${deps.holderOrigin}/`); return b; };
  try {
    const minting = await fresh();
    const createdId = await minting.runInPage<string>(`window.__create('chrome-gate@localhost')`);
    const creds = await minting.exportCredentials();
    if (creds.length !== 1) return { passed: false, reason: `export-count-${creds.length}` };
    const cred = creds[0] as { credentialId?: unknown };
    if (cred.credentialId !== createdId) return { passed: false, reason: 'export-id-mismatch' };
    await minting.close();
    const asserting = await fresh();
    await asserting.addCredential(creds[0]);
    const assertedId = await asserting.runInPage<string>('window.__get()');
    if (assertedId !== createdId) return { passed: false, reason: 'assert-id-mismatch' };
    if (!asserting.observedAssertion(createdId)) return { passed: false, reason: 'assertion-not-observed' };
    return { passed: true };
  } catch (err) {
    const name = err instanceof Error ? err.message.split(/[\s:]/)[0]?.slice(0, 60) || err.name : 'unknown';
    // A self-test that could not RUN (launch timeout, a crashed browser) is not evidence about the
    // authenticator: it is reported transient and never recorded, so the gate stays `unchecked`.
    return { passed: false, reason: `self-test-error:${name}`, transient: true };
  } finally {
    for (const b of opened) await b.close().catch(() => {}); // @silent-fallback-ok — best-effort close of throwaway fixture browsers
  }
}

/**
 * Ensure the gate for the current Chrome major: returns the recorded result when it matches,
 * otherwise runs the self-test once and records it. `force` re-runs it (the `recheck-chrome` op).
 */
export async function ensurePasskeyChromeGate(input: {
  store: PasskeyChromeGateStore;
  currentMajor: number | null;
  selfTest: () => Promise<ChromeGateSelfTestResult>;
  now?: () => Date;
  force?: boolean;
}): Promise<PasskeyChromeGate> {
  if (input.currentMajor === null) return 'unchecked';
  if (!input.force) {
    const existing = input.store.gateFor(input.currentMajor);
    if (existing !== 'unchecked') return existing;
  }
  const outcome = await input.selfTest();
  if (!outcome.passed && outcome.transient) return 'unchecked';
  const at = (input.now ?? (() => new Date()))().toISOString();
  input.store.write({ chromeMajor: input.currentMajor, result: outcome.passed ? 'passed' : 'failed', checkedAt: at,
    reason: outcome.passed ? null : outcome.reason });
  return outcome.passed ? 'passed' : 'failed';
}
