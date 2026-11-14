// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * context-budget-layered-summaries §9.1 + Phase 0 results check 4: Claude Code
 * hands the model a hook's stdout only up to 10,000 characters; a larger block
 * arrives as a ~2,000-character preview plus a file path. The post-compaction
 * recovery block was ~45 KB, so only its first lines reached the session.
 *
 *  - the fitter passes a block under the limit through unchanged;
 *  - over the limit it saves the full block (0600) and prints ≤ limit chars that
 *    keep the recovery marker, the newest conversation context, the Telegram
 *    session, a short identity/memory head, and an explicit Read instruction;
 *  - the rendered session-start hook fits a large recovery seed end to end;
 *  - the canary counts a block Claude Code cut to its preview as NOT recovered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { CompactionCanary, isTruncatedHookOutput } from '../../src/monitoring/compactionCanary.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/recovery-output-fit.test.ts';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rfit-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

/** A synthetic recovery block shaped like the real one (sections and sizes), no real content. */
function bigBlock(): string {
  const conv = ['--- CONVERSATION CONTEXT (Topic: 141133, 40 total messages) ---', 'SUMMARY: building the context budget work.', 'RECENT MESSAGES:'];
  for (let i = 1; i <= 60; i++) conv.push(`[2026-11-10 10:${String(i).padStart(2, '0')} PST] User: message number ${i} ${'detail '.repeat(12)}`);
  conv.push('NEWEST-MESSAGE-SENTINEL: the latest thing the user said', '--- END CONVERSATION CONTEXT ---');
  const ident = ['--- Your Identity (from .instar/AGENT.md) ---', '# Agent: Echo', ...Array.from({ length: 400 }, (_, i) => `principle line ${i} ${'words '.repeat(10)}`), '--- End Identity ---'];
  const mem = ['--- Your Memory (.instar/MEMORY.md — 1117 lines, showing first 50) ---', ...Array.from({ length: 50 }, (_, i) => `memory ${i} ${'fact '.repeat(15)}`), '--- End Memory ---'];
  const tg = ['--- TELEGRAM SESSION (topic 141133) ---', 'Reply with .instar/scripts/telegram-reply.sh 141133', '--- END TELEGRAM SESSION ---'];
  const disp = ['--- CONTEXT DISPATCH (when X arises, read Y) ---', ...Array.from({ length: 60 }, (_, i) => `when ${i} → read file-${i}.md ${'x'.repeat(80)}`)];
  return ['=== IDENTITY RECOVERY (post-compaction) ===', '', ...conv, '', ...ident, '', ...mem, '', ...tg, '', ...disp, '=== END IDENTITY RECOVERY ==='].join('\n');
}

function fitter(dir: string): string {
  const f = path.join(dir, 'fit-recovery-output.mjs');
  fs.writeFileSync(f, PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });
  return f;
}

describe('fit-recovery-output', () => {
  it('passes a block under the limit through unchanged and saves nothing', () => {
    const d = tmp();
    const dest = path.join(d, 'saved', 's1.txt');
    const small = '=== IDENTITY RECOVERY (post-compaction) ===\nhello\n=== END IDENTITY RECOVERY ===\n';
    const r = spawnSync('node', [fitter(d), '9000', dest], { input: small, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(small);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('over the limit: saves the whole block 0600, prints ≤ limit with the marker, the newest conversation, Telegram, and a Read instruction', () => {
    const d = tmp();
    const dest = path.join(d, 'state', 'context-layers', '_recovery', 'sid-1.txt');
    const block = bigBlock();
    expect(block.length).toBeGreaterThan(40_000);
    const r = spawnSync('node', [fitter(d), '9000', dest], { input: block, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out.length).toBeLessThanOrEqual(9000);
    expect(out.split('\n')[0]).toBe('=== IDENTITY RECOVERY (post-compaction) ===');
    expect(out).toContain('NEWEST-MESSAGE-SENTINEL');            // the newest conversation survives
    expect(out).toContain('SUMMARY: building the context budget work.'); // and its head
    expect(out).toContain('telegram-reply.sh 141133');
    expect(out).toContain('# Agent: Echo');
    expect(out).toContain(`READ THE FULL BLOCK NOW with the Read tool before continuing: ${dest}`);
    expect(out.trimEnd().endsWith('=== END IDENTITY RECOVERY ===')).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(block);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(dest)).mode & 0o777).toBe(0o700);
    // The marker sits inside the first 2,000 characters even if a later limit change cut it again.
    expect(out.indexOf('=== IDENTITY RECOVERY (post-compaction) ===')).toBeLessThan(2000);
  });

  it('a message quoting a diff header never ends the conversation section early', () => {
    const d = tmp();
    const block = bigBlock().replace('message number 3 ', 'message number 3 --- a/src/foo.ts\n--- b/src/foo.ts\n=== quoted header ===\n');
    const r = spawnSync('node', [fitter(d), '9000', path.join(d, 's.txt')], { input: block, encoding: 'utf-8' });
    expect(r.stdout).toContain('NEWEST-MESSAGE-SENTINEL');
    expect(r.stdout.length).toBeGreaterThan(6000); // the budget is used, not abandoned at the diff line
    expect(r.stdout.length).toBeLessThanOrEqual(9000);
  });

  it('the marker leads even with a large preamble or an unrecognised block', () => {
    const d = tmp();
    for (const input of ['P'.repeat(15_000) + '\n' + bigBlock(), 'just one huge unstructured blob '.repeat(1000)]) {
      const r = spawnSync('node', [fitter(d), '9000', path.join(d, 'u.txt')], { input, encoding: 'utf-8' });
      expect(r.stdout.split('\n')[0]).toBe('=== IDENTITY RECOVERY (post-compaction) ===');
      expect(r.stdout.length).toBeLessThanOrEqual(9000);
      expect(r.stdout.trimEnd().endsWith('=== END IDENTITY RECOVERY ===')).toBe(true);
    }
  });

  it('without a save path it still fits, and tells the session to read the identity files directly', () => {
    const d = tmp();
    const r = spawnSync('node', [fitter(d), '9000', ''], { input: bigBlock(), encoding: 'utf-8' });
    expect(r.stdout.length).toBeLessThanOrEqual(9000);
    expect(r.stdout).toContain('read .instar/AGENT.md and .instar/MEMORY.md now');
  });
});

describe('the rendered session-start hook fits a large recovery seed (end to end)', () => {
  it('a compact start prints ≤ 10,000 characters in total, saves the full block, and still writes the seeded marker', () => {
    const projectDir = tmp();
    const hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 1 }));
    const blockFile = path.join(projectDir, 'block.txt');
    fs.writeFileSync(blockFile, bigBlock());
    fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), `#!/bin/bash\ncat "${blockFile}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(hooksDir, 'fit-recovery-output.mjs'), PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });
    const migrator = new PostUpdateMigrator({ stateDir: path.join(projectDir, '.instar'), port: 1, sessions: { claudePath: 'claude' } } as never);
    const hook = path.join(hooksDir, 'session-start.sh');
    fs.writeFileSync(hook, (migrator as unknown as { getHookContent(n: string): string }).getHookContent('session-start'), { mode: 0o755 });
    const r = spawnSync('bash', [hook], {
      input: JSON.stringify({ source: 'compact', session_id: 'sess-abc' }),
      env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000, encoding: 'utf-8',
    });
    expect(r.stdout.length).toBeLessThanOrEqual(10_000);
    expect(r.stdout).toContain('=== IDENTITY RECOVERY (post-compaction) ===');
    expect(r.stdout).toContain('NEWEST-MESSAGE-SENTINEL');
    const saved = path.join(projectDir, '.instar', 'state', 'context-layers', '_recovery', 'sess-abc.txt');
    expect(fs.readFileSync(saved, 'utf-8').trimEnd()).toBe(bigBlock().trimEnd());
    expect(fs.existsSync(path.join(projectDir, '.instar', 'state', 'context-layers', '_seeded', 'sess-abc.json'))).toBe(true);
  });

  it('both installers write the fitter beside the recovery hook (update path and fresh init)', () => {
    const src = fs.readFileSync(path.resolve('src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(src).toContain("fs.writeFileSync(path.join(instarHooksDir, 'fit-recovery-output.mjs'), PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });");
    const init = fs.readFileSync(path.resolve('src/commands/init.ts'), 'utf-8');
    expect(init).toContain("fs.writeFileSync(path.join(hooksDir, 'fit-recovery-output.mjs'), PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });");
  });

  it('without the fitter, an oversize seed is printed raw and NO seeded marker is written (the server recovery path stays armed)', () => {
    const projectDir = tmp();
    const hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 1 }));
    const blockFile = path.join(projectDir, 'block.txt');
    fs.writeFileSync(blockFile, bigBlock());
    fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), `#!/bin/bash\ncat "${blockFile}"\n`, { mode: 0o755 });
    const migrator = new PostUpdateMigrator({ stateDir: path.join(projectDir, '.instar'), port: 1, sessions: { claudePath: 'claude' } } as never);
    const hook = path.join(hooksDir, 'session-start.sh');
    fs.writeFileSync(hook, (migrator as unknown as { getHookContent(n: string): string }).getHookContent('session-start'), { mode: 0o755 });
    const r = spawnSync('bash', [hook], { input: JSON.stringify({ source: 'compact', session_id: 'no-fitter' }), env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir }, timeout: 30_000, encoding: 'utf-8' });
    expect(r.stdout).toContain('NEWEST-MESSAGE-SENTINEL');
    expect(fs.existsSync(path.join(projectDir, '.instar', 'state', 'context-layers', '_seeded', 'no-fitter.json'))).toBe(false);
  });
});

describe('canary: a truncated delivery is not a recovery', () => {
  it('recognises Claude Code\'s oversize wrapper', () => {
    expect(isTruncatedHookOutput('<persisted-output>\nOutput too large (45.7KB). Full output saved to: /x\n')).toBe(true);
    expect(isTruncatedHookOutput('=== IDENTITY RECOVERY (post-compaction) ===\nfine')).toBe(false);
    // A conversation that merely mentions the phrase is not a truncation.
    expect(isTruncatedHookOutput('=== IDENTITY RECOVERY (post-compaction) ===\nUser: it said Output too large (45.7KB). Full output saved to: /x')).toBe(false);
  });

  it('counts the compaction as truncated and diverged, not complete', async () => {
    const d = tmp();
    const transcript = path.join(d, 't.jsonl');
    const canary = new CompactionCanary({ stateDir: d, machineId: 'm1' });
    const session = { topicKey: '141133', claudeSessionId: 'sid', transcriptPath: transcript, engine: 'claude-code' as const };
    fs.writeFileSync(transcript, '');
    await canary.scan([session], true);
    const ts = new Date().toISOString();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: ts, sessionId: 'sid', version: '2.1.322' }) + '\n');
    fs.appendFileSync(transcript, JSON.stringify({ type: 'attachment', uuid: 'a1', timestamp: ts, attachment: { type: 'hook_success', hookName: 'SessionStart:compact', command: 'bash .instar/hooks/instar/session-start.sh', exitCode: 0, stdout: '--- MACHINE LOAD ---\n=== IDENTITY RECOVERY (post-compaction) ===\n' + 'x'.repeat(45_000), content: '<persisted-output>\nOutput too large (45.7KB). Full output saved to: /tmp/x\n\nPreview (first 2KB):\n=== IDENTITY RECOVERY (post-compaction) ===\n...' } }) + '\n');
    await canary.scan([session], true);
    const rep = canary.report(true);
    expect(rep.recent[0]).toMatchObject({ recoveryBlock: false, recoveryTruncated: true });
    expect(rep.groups[0]).toMatchObject({ state: 'diverged', truncated: 1, complete: 0 });
  });
});
