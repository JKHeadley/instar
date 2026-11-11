// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The heal re-seed text as production builds it (context-budget-layered-summaries
 * §9.1 heal rung 2, `healReseedText`): a large packet is filed 0600 and the
 * typed stub carries the HEAL instructions — never the compaction-resume stub
 * that tells a session to announce the pause and answer the latest message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healReseedText } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { HEAL_RESEED_PREAMBLE, prepareInjectionText } from '../../src/messaging/shared/compactionResumePayload.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/heal-reseed-text.test.ts';

describe('healReseedText', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('a real-sized packet ⇒ a heal stub (no "answer the latest message" instruction) pointing at a 0600 file holding the heal preamble and the packet', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-text-')); dirs.push(tmpDir);
    const packet = 'STANDING PACKET\n' + 'operator row\n'.repeat(400);
    const text = healReseedText(141133, packet, { tmpDir });
    expect(text.startsWith('[telegram:141133] ')).toBe(true);
    expect(text).toMatch(/Do NOT send a message about this re-delivery/);
    expect(text).not.toMatch(/FIRST sentence/);
    expect(text).not.toMatch(/respond directly to the user's MOST RECENT/i);
    const file = /saved at (\S+\.txt)\./.exec(text)![1];
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(file, 'utf-8');
    expect(body.startsWith(HEAL_RESEED_PREAMBLE)).toBe(true);
    expect(body).toContain('STANDING PACKET');
  });

  it('contrast: the resume stub would have told the session to answer (why the heal has its own)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-text-')); dirs.push(tmpDir);
    expect(prepareInjectionText('x'.repeat(600), 'heal', 1, { tmpDir })).toMatch(/FIRST sentence/);
  });
});
