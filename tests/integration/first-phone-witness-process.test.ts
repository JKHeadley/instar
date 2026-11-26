import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

it('starts only when enabled and terminates the dedicated staging process on SIGTERM', async () => {
  const home = mkdtempSync(join(tmpdir(), 'first-phone-witness-process-'));
  const config = join(home, 'config.json');
  const database = join(home, 'witness.sqlite');
  function run(stopOnObservation = false) {
    return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
      const child = spawn(process.execPath, [
        resolve('node_modules/vite-node/vite-node.mjs'), resolve('src/witness/firstPhoneMain.ts'), config,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let sentStop = false;
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Witness process did not finish in the allotted time'));
      }, 12000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (stopOnObservation && !sentStop && output.includes('"result":"pending"')) {
          sentStop = true;
          child.kill('SIGTERM');
        }
      });
      child.once('close', code => { clearTimeout(timeout); resolveRun({ code, output }); });
    });
  }
  try {
    writeFileSync(config, JSON.stringify({ enabled: false }));
    expect(await run()).toEqual({ code: 0, output: '' });
    expect(existsSync(database)).toBe(false);

    const mirror = join(home, 'mirror.git');
    mkdirSync(mirror);
    SafeGitExecutor.execSync(['init', '--bare'], { cwd: mirror, operation: 'first-phone-witness-process:fixture' });
    writeFileSync(config, JSON.stringify({
      enabled: true, home, agentId: 'echo', repository: mirror, ref: 'refs/heads/missing', audience: 'fixture', intervalMs: 1000,
    }));
    const result = await run(true);
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe('{"event":"first-phone-witness-observation","result":"pending"}');
    expect(existsSync(database)).toBe(true);
  } finally {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'first-phone-witness-process-test:cleanup' });
  }
}, 30000);
