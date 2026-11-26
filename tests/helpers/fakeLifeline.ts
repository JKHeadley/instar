/**
 * A real process whose command line looks like an Instar lifeline
 * (`node -e … <dir>/.instar/instar-boot.cjs lifeline start --dir <dir>`), for tests of code that
 * checks a lifeline lock's pid really runs a lifeline (connectEnable.lifelineRunning). It runs
 * nothing but a timer. Write its pid into `<stateDir>/lifeline.lock` and stop it when done.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { processStartMs } from '../../src/core/processIdentity.js';

export interface FakeLifeline { pid: number; stop(): void }

export async function startFakeLifeline(stateDir: string): Promise<FakeLifeline> {
  const child: ChildProcess = spawn(process.execPath, [
    '-e', 'setTimeout(() => {}, 600000)',
    path.join(stateDir, 'instar-boot.cjs'), 'lifeline', 'start', '--dir', path.dirname(stateDir),
  ], { stdio: 'ignore' });
  if (!child.pid) throw new Error('fake lifeline did not start');
  await new Promise((r) => setTimeout(r, 150)); // let ps see the final argv
  // The shape the real lifeline writes (lifelineLock.ts): pid, startedAt, procStart.
  fs.writeFileSync(path.join(stateDir, 'lifeline.lock'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), procStart: processStartMs(child.pid) }));
  return { pid: child.pid, stop: () => { try { child.kill(); } catch { /* already gone */ } } };
}

/** An unrelated real process (a reused pid running something else). */
export function startUnrelatedProcess(): FakeLifeline {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('sleep did not start');
  return { pid: child.pid, stop: () => { try { child.kill(); } catch { /* already gone */ } } };
}
