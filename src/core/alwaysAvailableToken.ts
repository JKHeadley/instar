/**
 * The Claude sign-in for an agent that starts before anyone logs in
 * (docs/specs/create-agent-accounts-and-always-on.md §B.4). A LaunchDaemon can't read the login
 * keychain, so the agent needs a `claude setup-token` code as its main sign-in while Always available
 * is on.
 *
 * - The code is checked against the account the person chose (its email, through the OAuth profile),
 *   and a mismatch is refused. A code that can't be checked is refused too: never guessed.
 * - It is stored where `instar set-claude-key` stores it (`sessions.credentials.anthropic`, config at
 *   mode 0600), so every session of this agent uses it.
 * - A small record (`<stateDir>/state/always-available-token.json`, 0600) keeps whatever was there
 *   before. Turning Always available off puts that back, but only if the stored code is still the one
 *   set here. A code the person changed since is left alone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeClaudeToken, writeClaudeKeyToConfig } from './claudeChildAuth.js';
import { emailForClaudeToken, type OracleFetch } from './CredentialIdentityOracle.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const ALWAYS_AVAILABLE_TOKEN_FILE = 'always-available-token.json';

interface TokenRecord {
  version: 1;
  /** sha256 of the code this command stored; never the code itself. */
  setTokenSha256: string;
  email: string;
  setAt: string;
  /** What `sessions.credentials.anthropic` held before, or null when nothing did. Kept from the FIRST set. */
  previous: unknown;
}

const sha = (v: string) => crypto.createHash('sha256').update(v.trim()).digest('hex');

function recordPath(stateDir: string): string {
  return path.join(stateDir, 'state', ALWAYS_AVAILABLE_TOKEN_FILE);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function writeAtomic0600(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readRecord(stateDir: string): TokenRecord | null {
  try {
    const r = readJson(recordPath(stateDir)) as Partial<TokenRecord>;
    if (r.version === 1 && typeof r.setTokenSha256 === 'string' && typeof r.email === 'string') return r as TokenRecord;
  } catch { /* @silent-fallback-ok — no record means this command never set a code */ }
  return null;
}

function currentCredential(configFile: string): unknown {
  const cfg = readJson(configFile);
  const sessions = cfg.sessions as Record<string, unknown> | undefined;
  const creds = sessions?.credentials as Record<string, unknown> | undefined;
  return creds?.anthropic ?? null;
}

function credentialValue(c: unknown): string | null {
  return c && typeof c === 'object' && typeof (c as { value?: unknown }).value === 'string' ? (c as { value: string }).value : null;
}

export type TokenResult = { ok: true; email: string } | { ok: false; message: string };

export async function setAlwaysAvailableToken(opts: {
  stateDir: string;
  token: string;
  expectEmail: string;
  fetchImpl?: OracleFetch;
  now?: () => number;
}): Promise<TokenResult> {
  const token = opts.token.trim();
  if (!looksLikeClaudeToken(token)) {
    return { ok: false, message: "That doesn't look like a code from the Claude sign-in page. It starts with sk-ant-oat. Nothing was changed." };
  }
  const who = await emailForClaudeToken(token, { fetchImpl: opts.fetchImpl });
  if (!who.email) {
    return { ok: false, message: `This code couldn't be checked with Claude (${who.reason ?? 'no answer'}). Nothing was changed. Try again in a minute.` };
  }
  if (who.email.toLowerCase() !== opts.expectEmail.trim().toLowerCase()) {
    return { ok: false, message: `This code signs in as ${who.email}, not ${opts.expectEmail}. Sign in to Claude as ${opts.expectEmail}, then paste the new code. Nothing was changed.` };
  }
  const configFile = path.join(opts.stateDir, 'config.json');
  const existing = readRecord(opts.stateDir);
  const current = currentCredential(configFile);
  const currentValue = credentialValue(current);
  // Keep the ORIGINAL earlier credential across repeated sets, but only while the stored code is still
  // this command's: a key the person set by hand in between becomes the one to restore.
  const stillOurs = !!existing && !!currentValue && sha(currentValue) === existing.setTokenSha256;
  const record: TokenRecord = {
    version: 1,
    setTokenSha256: sha(token),
    email: who.email,
    setAt: new Date((opts.now ?? Date.now)()).toISOString(),
    previous: stillOurs ? existing!.previous : current,
  };
  writeAtomic0600(recordPath(opts.stateDir), record);
  writeClaudeKeyToConfig(configFile, token);
  return { ok: true, email: who.email };
}

/**
 * Undo for turning Always available off. Restores the earlier credential only while the stored code is
 * still the one set here; a code changed since is the person's and stays.
 */
export function clearAlwaysAvailableToken(stateDir: string): { ok: true; restored: boolean } {
  const record = readRecord(stateDir);
  if (!record) return { ok: true, restored: false };
  const configFile = path.join(stateDir, 'config.json');
  const current = credentialValue(currentCredential(configFile));
  let restored = false;
  if (current && sha(current) === record.setTokenSha256) {
    const cfg = readJson(configFile);
    const sessions = (cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {}) as Record<string, unknown>;
    const creds = (sessions.credentials && typeof sessions.credentials === 'object' ? sessions.credentials : {}) as Record<string, unknown>;
    if (record.previous === null || record.previous === undefined) delete creds.anthropic;
    else creds.anthropic = record.previous;
    if (Object.keys(creds).length) sessions.credentials = creds; else delete sessions.credentials;
    cfg.sessions = sessions;
    writeAtomic0600(configFile, cfg);
    restored = true;
  }
  try { SafeFsExecutor.safeUnlinkSync(recordPath(stateDir), { operation: 'always-available token record cleared' }); } catch { /* @silent-fallback-ok — already gone */ }
  return { ok: true, restored };
}

/**
 * True while the Always available code is this agent's Claude sign-in. Sessions then aren't pinned to a
 * subscription-pool account (spec §B.4: the code overrides the pool), so usage is counted against the
 * account the code signs in as, not a pool folder the session doesn't use.
 */
export function alwaysAvailableTokenInUse(stateDir: string, heldKey: string | null | undefined): boolean {
  // The key the running server holds (it re-reads the file about once a minute), so the pool decision
  // and the sign-in sessions actually launch with never disagree in between.
  if (!heldKey) return false;
  const record = readRecord(stateDir);
  return !!record && sha(heldKey) === record.setTokenSha256;
}

/** Whether this command's code is the one in use, and for which email (no network). */
export function alwaysAvailableTokenStatus(stateDir: string): { set: boolean; email: string | null } {
  const record = readRecord(stateDir);
  if (!record) return { set: false, email: null };
  let current: string | null = null;
  try { current = credentialValue(currentCredential(path.join(stateDir, 'config.json'))); } catch { /* @silent-fallback-ok — unreadable config reads as not set */ }
  return current && sha(current) === record.setTokenSha256 ? { set: true, email: record.email } : { set: false, email: null };
}
