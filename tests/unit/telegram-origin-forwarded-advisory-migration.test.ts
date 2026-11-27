/**
 * native-conversation-forwarded-advisory (slice 3g) — agent awareness, migration parity
 * and the server wiring that makes the advisory hand-back live (wiring integrity:
 * not null, not a no-op).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginHeldLateAwareness, HELD_REPLY_ADVISORY_AWARENESS_MARKER, HELD_REPLY_LATE_AWARENESS_MARKER } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('the advisory line in the held-reply awareness', () => {
  it('new agents learn the line and its two answers', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginHeldLateAwareness());
    for (const phrase of [HELD_REPLY_ADVISORY_AWARENESS_MARKER, '--tone-complied RULE --tone-decision-ref REF', '--tone-ack RULE --tone-reason', 'nothing else ever sends it']) expect(md).toContain(phrase);
  });
  it('an agent that already has the held-reply paragraph gains the two sentences once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'held-advisory-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    const strip = (text: string) => text.replace(/ A reply the outbound check handed back while it was held[^]*?nothing else ever sends it\./g, '');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1741' }).migrate();
      // An agent updated to slice 3a: the held-reply paragraph without the advisory sentences.
      migrate();
      fs.writeFileSync(md, strip(fs.readFileSync(md, 'utf8')));
      expect(fs.readFileSync(md, 'utf8')).not.toContain(HELD_REPLY_ADVISORY_AWARENESS_MARKER);
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(HELD_REPLY_LATE_AWARENESS_MARKER)).toHaveLength(2);
      expect(text.split(HELD_REPLY_ADVISORY_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(HELD_REPLY_ADVISORY_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:held-advisory-migration:cleanup' });
    }
  });
});

describe('server wiring (the advisory hand-back is live, not a no-op)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf8');
  const mesh = fs.readFileSync(path.join(process.cwd(), 'src/messaging/telegram-origin/OriginMesh.ts'), 'utf8');
  it('the forward ladder records the holder advisory and hands its line to the runtime', () => {
    const block = source.slice(source.indexOf('runtime.options.forwardRecovery = async (operation, row) => {'), source.indexOf('runtime.options.onLeaseHoldObserved = async row => {'));
    expect(block).toContain('markAdvisory: (operationId, verdict) => runtime.store.markForwardAdvisory(');
    expect(block).toContain('onAdvisory: advisoryRow => runtime.handAdvisory(advisoryRow)');
  });
  it('an answer to a handed-back forward supersedes locally before it is forwarded', () => {
    expect(source).toContain('advisoryReplacementOf: answer.originalId');
    for (const wire of ['supersede: async (originalId, next, detail) =>', 'runtime.store.supersedeWithAdmission({ operationId: originalId', "runtime.service.settleAdvisoryAnswer(ok ? 'superseded' : 'closed')",
      'markAdvisory: (operationId, verdict) => runtime.store.markForwardAdvisory(', 'noteAnsweredInline: operationId => runtime.noteVerdictAnsweredInline(operationId)']) expect(source).toContain(wire);
  });
  it('the reply route resolves the answer reference on this machine and answers a closed one with its recorded outcome', () => {
    for (const wire of ['originRuntime.findAdvisoryAnswer(', 'originRuntime.service.setAdvisoryAnswer(', 'new AdvisoryAnswerClosedError(match.operationId)',
      'originRuntime.service.dropOperationReference()', 'isOperationReference(rawToneAdvisoryDecisionRef) ? undefined']) expect(routes).toContain(wire);
  });
  it('the holder answers "not sent" only after it ended its copy', () => {
    expect(mesh).toContain('runtime.endForPolicy(record, error.decision)');
    expect(mesh).toContain('copyEnded: true');
  });
});
