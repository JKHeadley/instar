// Meta-verification fixture — records this ROOT's test-execution window
// (start/end wall-clock stamps) so the harness can assert that K concurrent
// roots under an ENFORCING cap=1 never overlap (§5 mass-admit regression).
import { test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { stampWorker } from './fixture-helpers.js';

stampWorker();

test('stamp execution window', async () => {
  const dir = process.env['FIXTURE_STAMP_DIR'];
  if (!dir) return; // stamping not active for this scenario — trivial pass
  fs.mkdirSync(dir, { recursive: true });
  const sleepMs = Number(process.env['FIXTURE_SLEEP_MS'] ?? '2000');
  fs.writeFileSync(
    path.join(dir, `window-start-${process.pid}.json`),
    JSON.stringify({ t: Date.now(), pid: process.pid }),
  );
  await new Promise((r) => setTimeout(r, sleepMs));
  fs.writeFileSync(
    path.join(dir, `window-end-${process.pid}.json`),
    JSON.stringify({ t: Date.now(), pid: process.pid }),
  );
}, 30_000);
