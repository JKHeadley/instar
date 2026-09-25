import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderClaudeTranscript,
  findClaudeJobTranscript,
  readJobTranscriptEvidence,
} from '../../src/scheduler/jobTranscriptEvidence.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { parseClaimedEffects } from '../../src/scheduler/JevJobCompletionAudit.js';

const SID = '83b5539f-a945-4ff5-ad8d-22b0d609e38c';

function line(o: unknown): string { return JSON.stringify(o); }
function toolUse(id: string, command: string) {
  return line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
}
function toolResult(id: string, content: string, isError = false) {
  return line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
}
function reply(text: string) {
  return line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

describe('renderClaudeTranscript', () => {
  it('renders each command and its result, final reply last (a silent health check is no longer blank)', () => {
    const out = renderClaudeTranscript([
      toolUse('a', 'curl -s http://localhost:4042/health'),
      toolResult('a', '{"status":"ok"}'),
      toolUse('b', 'df -h'),
      toolResult('b', '/dev/disk3s1s1 926Gi 16Gi 682Gi 3% /'),
      reply('All healthy.'),
    ].join('\n'));
    expect(out).toContain('[job transcript: 2 tool step(s)]');
    expect(out).toContain('$ curl -s http://localhost:4042/health');
    expect(out).toContain('{"status":"ok"}');
    expect(out).toContain('$ df -h');
    expect(out.trim().endsWith('[final reply] All healthy.')).toBe(true);
  });

  it('marks failed steps so the audit can see an error the job glossed over', () => {
    const out = renderClaudeTranscript([toolUse('a', 'curl -sf x'), toolResult('a', 'exit 7', true), reply('Done.')].join('\n'));
    expect(out).toContain('result (error): exit 7');
  });

  it('clamps a huge result so several steps fit the audit tail', () => {
    const out = renderClaudeTranscript([toolUse('a', 'cat big'), toolResult('a', 'x'.repeat(50_000))].join('\n'));
    expect(out.length).toBeLessThan(1_500);
    expect(out).toMatch(/\[\+\d+ chars\]/);
  });

  it('re-emits EFFECT claims from the job\'s own reply on their own lines', () => {
    const out = renderClaudeTranscript(reply('Updated the bookmark.\nEFFECT: .instar/state/bm.json'));
    expect([...parseClaimedEffects(out)]).toEqual(['.instar/state/bm.json']);
  });

  it('counts an EFFECT line printed by an echo step', () => {
    const out = renderClaudeTranscript([toolUse('a', 'echo "EFFECT: .instar/MEMORY.md"'), toolResult('a', 'EFFECT: .instar/MEMORY.md')].join('\n'));
    expect([...parseClaimedEffects(out)]).toEqual(['.instar/MEMORY.md']);
  });

  it('does NOT count an EFFECT line that only appears in a file the job read', () => {
    const out = renderClaudeTranscript([toolUse('a', 'cat notes.md'), toolResult('a', 'EFFECT: .instar/MEMORY.md'), reply('Nothing to save.')].join('\n'));
    expect(parseClaimedEffects(out).size).toBe(0);
  });

  it('tolerates a torn first line and returns empty for no usable records', () => {
    expect(renderClaudeTranscript('{"type":"assi')).toBe('');
    const out = renderClaudeTranscript(`{"torn\n${reply('ok')}`);
    expect(out).toContain('[final reply] ok');
  });
});

describe('findClaudeJobTranscript / readJobTranscriptEvidence', () => {
  let home: string;
  const projectDir = '/Users/someone/.instar/agents/echo';
  const encoded = projectDir.replace(/[\/.]/g, '-');

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'jte-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'test-cleanup' }); });

  function writeAt(configDir: string, body: string): string {
    const dir = path.join(home, configDir, 'projects', encoded);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(p, body);
    return p;
  }

  it('finds a transcript under a subscription-pool config home (the pane, and its env, are gone)', () => {
    const p = writeAt('.claude-followme-acct', reply('ok'));
    expect(findClaudeJobTranscript(SID, projectDir, home)).toBe(p);
  });

  it('finds the default-home transcript', () => {
    const p = writeAt('.claude', reply('ok'));
    expect(findClaudeJobTranscript(SID, projectDir, home)).toBe(p);
  });

  it('returns null when absent or when the id is not a UUID (no path games)', () => {
    expect(findClaudeJobTranscript(SID, projectDir, home)).toBeNull();
    writeAt('.claude', reply('ok'));
    expect(findClaudeJobTranscript('../../etc/passwd', projectDir, home)).toBeNull();
  });

  it('reads and renders; any failure yields empty so the caller keeps the pane capture', () => {
    const p = writeAt('.claude', [toolUse('a', 'df -h'), toolResult('a', 'disk ok'), reply('fine')].join('\n'));
    expect(readJobTranscriptEvidence(p)).toContain('$ df -h');
    expect(readJobTranscriptEvidence(null)).toBe('');
    expect(readJobTranscriptEvidence(path.join(home, 'missing.jsonl'))).toBe('');
  });
});
