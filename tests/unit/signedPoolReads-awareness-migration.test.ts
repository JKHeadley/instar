/**
 * native-conversation-any-machine-access §3d — agent awareness and migration parity for the
 * signed pool reads, and the capability/fallback rule.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { signedPoolReadsAwareness, SIGNED_POOL_READS_AWARENESS_MARKER, SignedReadCapability, bearerFallbackPermitted, signedThenBearer } from '../../src/core/poolSignedReads.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('signed pool reads awareness installation parity', () => {
  it('new agents learn the read, the paging fields and the refusals', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(signedPoolReadsAwareness(4042));
    for (const phrase of ['needs no shared API token', 'asleepOrUnreachable', 'clipped: true', 'nextBeforeIndex', 'rowTruncated', 'private to someone else', '/pool/signed-reads']) {
      expect(md).toContain(phrase);
    }
    // Agents without Telegram get it too.
    expect(generateClaudeMd('solo', 'Solo', 4042, false)).toContain(SIGNED_POOL_READS_AWARENESS_MARKER);
  });
  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'signed-reads-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1740' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(SIGNED_POOL_READS_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(SIGNED_POOL_READS_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:signed-reads-migration:cleanup' });
    }
  });
});

describe('bearer fallback only on the named reasons', () => {
  it('no-handler; claim-unauthorized only from an absent or older advert; never on another refusal', () => {
    expect(bearerFallbackPermitted('transcript', { status: 501, ok: false, reason: 'no-handler' }, '1.3.1800')).toBe(true);
    expect(bearerFallbackPermitted('transcript', { status: 403, ok: false, reason: 'claim-unauthorized' }, null)).toBe(true);
    expect(bearerFallbackPermitted('transcript', { status: 403, ok: false, reason: 'claim-unauthorized' }, '1.3.1739')).toBe(true);
    expect(bearerFallbackPermitted('transcript', { status: 403, ok: false, reason: 'claim-unauthorized' }, '1.3.1740')).toBe(false);
    expect(bearerFallbackPermitted('transcript', { status: 403, ok: false, reason: 'not-registered' }, null)).toBe(false);
    expect(bearerFallbackPermitted('transcript', { status: 200, ok: true, result: { ok: false, reason: 'unknown-session' } }, null)).toBe(false);
  });
  it('a timeout is reported and never sends the token; a remembered older peer goes straight to bearer until its version changes', async () => {
    const cap = new SignedReadCapability();
    let bearerCalls = 0;
    const bearer = async () => { bearerCalls++; return 'via bearer'; };
    const timedOut = await signedThenBearer({ machineId: 'm1', kind: 'transcript', peerVersion: '1.3.1700', capability: cap,
      signed: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, accept: () => 'x', bearer });
    expect(timedOut).toEqual({ via: null, error: 'timed out', unreachable: true });
    expect(bearerCalls).toBe(0);
    let signedCalls = 0;
    const older = { status: 403, ok: false, reason: 'claim-unauthorized' };
    const read = (v: string) => signedThenBearer({ machineId: 'm1', kind: 'transcript', peerVersion: v, capability: cap,
      signed: async () => { signedCalls++; return older; }, accept: () => 'x', bearer });
    expect(await read('1.3.1700')).toEqual({ via: 'bearer', value: 'via bearer' });
    expect(await read('1.3.1700')).toEqual({ via: 'bearer', value: 'via bearer' });
    expect(signedCalls).toBe(1);
    await read('1.3.1701');
    expect(signedCalls).toBe(2);
    expect(cap.status(['m1']).counts).toEqual({ signedReads: 0, bearerReads: 3, failuresNotDowngraded: 1 });
    expect(cap.bearerFallbackNeededBy(['m1'])).toEqual([{ machineId: 'm1', kinds: ['transcript', 'list', 'historyPool'] }]);
  });
  it('signed capability is per kind', async () => {
    const cap = new SignedReadCapability();
    await signedThenBearer({ machineId: 'm2', kind: 'historyPool', peerVersion: '1.3.1740', capability: cap,
      signed: async () => ({ status: 200, ok: true, result: { ok: true, shape: 'pool' } }), accept: (r) => r, bearer: null });
    expect(cap.signedCapable('m2')).toEqual({ transcript: false, list: false, historyPool: true });
    expect(cap.bearerFallbackNeededBy(['m2'])).toEqual([{ machineId: 'm2', kinds: ['transcript', 'list'] }]);
  });
});
