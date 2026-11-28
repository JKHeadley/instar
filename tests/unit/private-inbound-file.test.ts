/** SEC-138: long WhatsApp/iMessage bodies are saved owner-only inside the agent's own folder. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { writePrivateInboundFile, getTelegramInboundDir } from '../../src/messaging/shared/telegramInboundFiles.js';

let projectDir: string;
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec138-')); });
afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/private-inbound-file.test.ts' }));

describe('writePrivateInboundFile (SEC-138)', () => {
  it('writes inside the project inbound folder, owner-only, with the exact content', () => {
    const fp = writePrivateInboundFile(projectDir, 'wa-15550001111', 'hello body');
    expect(path.dirname(fp)).toBe(getTelegramInboundDir(projectDir));
    expect(fs.readFileSync(fp, 'utf8')).toBe('hello body');
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(fp)).mode & 0o777).toBe(0o700);
  });
  it('gives two writes in the same moment different names', () => {
    const a = writePrivateInboundFile(projectDir, 'im-x', 'a');
    const b = writePrivateInboundFile(projectDir, 'im-x', 'b');
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, 'utf8')).toBe('a');
  });
  it('keeps the name inside the folder whatever the prefix holds', () => {
    const fp = writePrivateInboundFile(projectDir, '../../etc/passwd x', 'z');
    expect(path.dirname(fp)).toBe(getTelegramInboundDir(projectDir));
    expect(path.basename(fp)).toMatch(/^etcpasswdx-\d+-[0-9a-f]{8}\.txt$/);
  });
  it('tightens an existing folder of ours that was made with a loose mode', () => {
    const dir = getTelegramInboundDir(projectDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writePrivateInboundFile(projectDir, 'slack-ctx-C1', 'ctx');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
