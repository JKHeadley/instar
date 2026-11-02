/**
 * app-reply.sh --file (docs/specs/mobile-native-chat-media.md §4.6): with files and no text
 * argument the script never reads stdin, so a stdin that never closes cannot hang it.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'app-reply.sh');

describe('app-reply.sh --file', () => {
  it('returns with an open, never-closed stdin and posts the files with an empty caption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appreply-'));
    try {
      const file = path.join(dir, 'a.txt');
      fs.writeFileSync(file, 'x');
      // Port 1 refuses at once: the script reaches the POST (or fails transport) without reading stdin.
      const child = spawn('bash', [SCRIPT, '--file', file], { cwd: dir, env: { ...process.env, INSTAR_PORT: '1', INSTAR_AUTH_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('app-reply.sh blocked on stdin')); }, 15_000);
        child.on('exit', (c) => { clearTimeout(t); resolve(c); });
      });
      expect(code).toBe(1);
      expect(stderr).not.toContain('no message text provided');
      expect(stderr).toMatch(/AMBIGUOUS|Failed/);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/app-reply-script-files.test.ts' });
    }
  });
});
