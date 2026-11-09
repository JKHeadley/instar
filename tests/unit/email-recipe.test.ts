/**
 * docs/specs/backup-email-sending.md — the email-v1 recipe and its edges: the key route's check (never a
 * recipient; shape B's login must be the typed address), the check that needs the proof, the switch-off that
 * drains first, the yes row's recipient hash and timezone, `deliver` on jobs.json and the AGENT.md manifest
 * (refused on script jobs), the transcript's final message as the body, the mesh command's RBAC row, the
 * CLAUDE.md awareness on both paths, and the wiring helpers (the report reserve, the email day zone).
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SETUP_RECIPES, RULES, type EmailRecipeSurface, type RecipeDeps } from '../../src/recommended/recipes.js';
import { validateRow, RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { validateJob } from '../../src/scheduler/JobLoader.js';
import { validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';
import { finalAssistantText } from '../../src/scheduler/jobTranscriptEvidence.js';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';
import { PostUpdateMigrator, EMAIL_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { remainingEmailedJobsToday, resolveEmailTimezone, emailRowIdForExecution } from '../../src/email/wireEmail.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import type { JobDefinition } from '../../src/core/types.js';

const recipe = SETUP_RECIPES.find((r) => r.id === 'email-v1')!;
const OWNER = 'owner@example.com';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/email-recipe.test.ts' }); });

function surface(over: Partial<EmailRecipeSurface> = {}): EmailRecipeSurface {
  return {
    verifyCredential: async () => ({ result: 'pass', detail: 'ok.' }),
    proven: () => ({ proven: true, detail: 'proven.' }),
    prove: async () => ({ result: 'pass', detail: 'proof.' }),
    drain: async () => 0,
    forget: () => undefined,
    recipient: () => OWNER,
    ...over,
  };
}

describe('the email-v1 recipe', () => {
  it('names one secret and carries the shared rules and the three shapes as equals', () => {
    expect(recipe.service).toBe('email');
    expect(recipe.secretName).toBe('email_sending');
    const brief = recipe.brief({ port: 4040 });
    expect(brief).toContain(RULES('email', 4040).trim().split('\n')[1]);
    for (const s of ['A. A free Resend account', 'B. Their own Gmail or iCloud', 'C. A mailbox of my own']) expect(brief).toContain(s);
    expect(brief).toMatch(/Never add or verify a domain/);
    expect(brief).toMatch(/signup-mail/);
    expect(brief).toMatch(/never put it on a command line/);
    expect(brief).toMatch(/Only their explicit yes in this topic lets you turn it on/);
  });
  it('the key route: refuses a recipient, a shape B login that is not the typed address, and writes the split secrets', () => {
    const deps = (secrets: Record<string, string>): RecipeDeps => ({ readSecret: (n) => secrets[n] ?? null });
    expect(recipe.prepareKey!(JSON.stringify({ shape: 'A', transport: 'resend', secret: 'k', recipient: 'x@y.com' }), deps({ email_recipient: OWNER }))).toEqual({ error: 'recipient-not-accepted' });
    expect(recipe.prepareKey!(JSON.stringify({ shape: 'A', transport: 'resend', secret: 'k' }), deps({}))).toEqual({ error: 'no-recipient' });
    expect(recipe.prepareKey!(JSON.stringify({ shape: 'B', transport: 'smtp', preset: 'gmail', username: 'someone.else@gmail.com', secret: 'p' }), deps({ email_recipient: OWNER }))).toEqual({ error: 'recipient-mismatch' });
    expect(recipe.prepareKey!(JSON.stringify({ shape: 'C', transport: 'smtp', preset: 'gmail', username: OWNER, secret: 'p' }), deps({ email_recipient: OWNER }))).toEqual({ error: 'agent-mailbox-is-the-recipient' });
    const ok = recipe.prepareKey!(JSON.stringify({ shape: 'A', transport: 'resend', secret: 'k', providerAccountPassword: 'acct' }), deps({ email_recipient: OWNER }));
    expect(ok).toEqual({ writes: [['email_sending', JSON.stringify({ shape: 'A', transport: 'resend', secret: 'k' })], ['email_provider_account', 'acct']] });
  });
  it('the check passes only with a working credential and a passed proof', async () => {
    expect((await recipe.verify({ readSecret: () => null, email: surface() })).result).toBe('pass');
    expect((await recipe.verify({ readSecret: () => null, email: surface({ proven: () => ({ proven: false, detail: 'Waiting for the code.' }) }) }))).toMatchObject({ result: 'fail', detail: expect.stringContaining('code') });
    expect((await recipe.verify({ readSecret: () => null, email: surface({ verifyCredential: async () => ({ result: 'unknown', detail: 'down' }) }) })).result).toBe('unknown');
    expect((await recipe.verify({ readSecret: () => null })).result).toBe('unknown');
  });
  it('switch-off drains first, then removes only what setup stored; the account stays the person’s', async () => {
    const store: Record<string, string> = { email_sending: 'x', email_recipient: OWNER, email_provider_account: 'p' };
    let forgot = false;
    const base = { readSecret: (n: string) => store[n] ?? null, deleteSecret: (n: string) => { delete store[n]; } };
    const held = await recipe.stop({ ...base, setUpHere: true, email: surface({ drain: async () => 2 }) });
    expect(held.stopped).toBe(false);
    expect(store.email_sending).toBe('x');
    const done = await recipe.stop({ ...base, setUpHere: true, email: surface({ forget: () => { forgot = true; } }) });
    expect(done).toMatchObject({ stopped: true, changed: true });
    expect(store).toEqual({});
    expect(forgot).toBe(true);
    expect(done.detail).toMatch(/email details are gone from here/);
  });
});

describe('the yes row', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const signer: MachineSigner = { machineId: () => 'm_a', signerKeyHash: () => 'h', sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']> };
  it('carries the recipient hash and the timezone, and refuses them on a no or a malformed hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-ledger-'));
    dirs.push(dir);
    const ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    const hash = 'a'.repeat(64);
    const yes = ledger.recordYes({ service: 'email', origin: 'person-asked', offerTextHash: 'o', grantMachine: 'm_a', principal: '42', recipientHash: hash, timezone: 'America/Los_Angeles' });
    expect(yes).toMatchObject({ recipientHash: hash, timezone: 'America/Los_Angeles' });
    expect(ledger.activeGrant('email', 'm_a')?.recipientHash).toBe(hash);
    const noRow = { ...yes, choice: 'no', grantMachine: undefined, principal: undefined, knownNos: undefined };
    expect(validateRow(noRow)).toBeNull();
    expect(validateRow({ ...yes, recipientHash: 'not-hex' })).toBeNull();
    expect(validateRow({ ...yes, timezone: 'bad zone;' })).toBeNull();
    const { recipientHash: _r, timezone: _t, ...older } = yes;
    expect(validateRow(older)).not.toBeNull();
  });
});

describe('deliver on jobs', () => {
  const base = { slug: 's', name: 'n', description: 'd', schedule: '0 9 * * *', priority: 'medium', enabled: true, execute: { type: 'prompt', value: 'v' } };
  it('jobs.json: accepts telegram and email, refuses anything else, and refuses email on a script job', () => {
    expect(() => validateJob({ ...base, deliver: ['email'] })).not.toThrow();
    expect(() => validateJob({ ...base, deliver: ['telegram', 'email'] })).not.toThrow();
    expect(() => validateJob({ ...base, deliver: [] })).toThrow(/deliver/);
    expect(() => validateJob({ ...base, deliver: ['sms'] })).toThrow(/deliver/);
    expect(() => validateJob({ ...base, deliver: ['email', 'email'] })).toThrow(/deliver/);
    expect(() => validateJob({ ...base, execute: { type: 'script', value: './x.sh' }, deliver: ['email'] })).toThrow(/deliver-on-script-job/);
  });
  it('an older-version job file with an unknown field still loads (validateJob has no closed field set)', () => {
    expect(() => validateJob({ ...base, someFutureField: true })).not.toThrow();
  });
  it('the AGENT.md manifest accepts it (the loaded job carries it: tests/e2e/email-sending-lifecycle.test.ts)', () => {
    const manifest = validateManifest({ slug: 's', origin: 'user', name: 'n', description: 'd', schedule: '0 9 * * *', priority: 'medium', expectedDurationMinutes: 5, enabled: true, execute: { type: 'prompt', value: 'v' }, deliver: ['email'] });
    expect(manifest.deliver).toEqual(['email']);
    expect(() => validateManifest({ slug: 's', origin: 'user', name: 'n', description: 'd', schedule: '0 9 * * *', priority: 'medium', expectedDurationMinutes: 5, enabled: true, execute: { type: 'script', value: './x' }, deliver: ['email'] })).toThrow(/deliver-on-script-job/);
  });
});

describe('the report body', () => {
  it('is the final assistant message, all of its text blocks, uncut to 16 KB', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'early chatter' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Final part one.' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'Final part two.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n');
    expect(finalAssistantText(`{torn line\n${lines}`)).toBe('Final part one.\n\nFinal part two.');
    const big = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'é'.repeat(20_000) }] } });
    expect(Buffer.byteLength(finalAssistantText(big))).toBeLessThanOrEqual(16 * 1024);
    expect(finalAssistantText('')).toBe('');
  });
});

describe('multi-machine surfaces', () => {
  it('the email-send-forward command has its RBAC row (any registered peer; the holder’s handler is the gate)', () => {
    const verdict = checkCommandRBAC({ type: 'email-send-forward', id: 'em-x0000001', kind: 'one-off', subject: 's', text: 't', topicText: 't', fallbackTopicId: 9 }, 'm_b', { routerHolder: () => 'm_a' } as never);
    expect(verdict).toEqual({ ok: true, reason: 'ok' });
  });
  it('the outbox is its own journal kind', () => {
    expect(JOURNAL_KINDS).toContain('email-outbox-record');
  });
});

describe('agent awareness', () => {
  it('is in the template and reaches an existing agent once on update', () => {
    const marker = 'Email messages to the owner (';
    expect(EMAIL_CLAUDEMD_SECTION(4040)).toContain(marker);
    expect(EMAIL_CLAUDEMD_SECTION(4040).length).toBeLessThan(1600);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain(marker);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mig-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Agent\n');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4040, hasTelegram: false, projectName: 'p' } as never);
    const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    run(); run();
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8').split(marker).length - 1).toBe(1);
  });
});

describe('wiring helpers', () => {
  it('the report reserve counts today’s remaining runs of emailing jobs, in the email zone', () => {
    const j = (over: Partial<JobDefinition>) => ({ slug: 's', name: 'n', description: 'd', schedule: '0 * * * *', priority: 'medium', expectedDurationMinutes: 1, model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'v' }, deliver: ['email'], ...over }) as JobDefinition;
    const now = Date.parse('2026-11-08T20:30:00Z');
    expect(remainingEmailedJobsToday([j({})], now, 'UTC')).toBe(3);
    expect(remainingEmailedJobsToday([j({ deliver: ['telegram'] }), j({ enabled: false }), j({ execute: { type: 'script', value: 'x' } })], now, 'UTC')).toBe(0);
    expect(remainingEmailedJobsToday([j({ schedule: '0 9 * * *' })], now, 'America/Los_Angeles')).toBe(0);
  });
  it('the email day zone: config, then the yes row, then this machine', () => {
    expect(resolveEmailTimezone('Europe/Berlin', null)).toBe('Europe/Berlin');
    expect(resolveEmailTimezone(undefined, { timezone: 'Asia/Tokyo' } as never)).toBe('Asia/Tokyo');
    expect(resolveEmailTimezone(undefined, null)).toBeTruthy();
  });
  it('a report’s row id is a stable function of its execution id', () => {
    expect(emailRowIdForExecution('daily-1')).toBe(emailRowIdForExecution('daily-1'));
    expect(emailRowIdForExecution('daily-1')).toMatch(/^em-run-[0-9a-f]{32}$/);
  });
});
