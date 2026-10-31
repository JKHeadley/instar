import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const seamUrl = new URL('../../../dist/localVerify/orchestratorSeams.js', import.meta.url).href;

/** The service launches runVerifyMain as a detached process-group leader. */
function inVerifierGroup(childCode: string): Promise<{ status: number | null; output: string }> {
  const script = `import { realExec } from ${JSON.stringify(seamUrl)}; const r = await realExec(process.execPath, ['-e', ${JSON.stringify(childCode)}], { cwd: process.cwd(), env: process.env, deadlineMs: 5000, isolatedGroup: true }); console.log('RESULT:' + JSON.stringify(r));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } } reject(new Error(output || 'preflight group test timed out')); }, 15_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('real preflight process-group cleanup', () => {
  it('confirms a normal targeted process leaves no worker behind', async () => {
    const r = await inVerifierGroup('process.stdout.write("ok")');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.output.split('RESULT:')[1])).toMatchObject({ status: 0, quiescent: true });
  }, 20_000);

  it('kills a detached-stdio descendant before confirming quiescence', async () => {
    const childCode = 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref();';
    const r = await inVerifierGroup(childCode);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.output.split('RESULT:')[1])).toMatchObject({ status: 0, quiescent: true });
  }, 20_000);
});
