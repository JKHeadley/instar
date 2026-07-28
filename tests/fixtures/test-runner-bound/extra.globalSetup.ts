/**
 * Meta-verification fixture — a stand-in for a pre-existing globalSetup (the
 * integration config's build-dist shape, spec §2.2). withTestRunnerBound must
 * PREPEND the semaphore globalSetup ahead of this one, so the recorded stamp
 * here must postdate the semaphore's ledger `acquire` timestamp.
 */
import fs from 'node:fs';
import path from 'node:path';

export default function setup(): void {
  const dir = process.env['FIXTURE_OUT_DIR'];
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extra-globalsetup.json'),
    JSON.stringify({ t: Date.now(), pid: process.pid }),
  );
}
