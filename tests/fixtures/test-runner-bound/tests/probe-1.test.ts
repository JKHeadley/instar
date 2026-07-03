// Meta-verification fixture — concurrency probe 1 of 5 (see fixture-helpers.ts).
import { test } from 'vitest';

import { runProbe, stampWorker } from './fixture-helpers.js';

stampWorker();

test('probe-1 barrier window', async () => {
  await runProbe('probe-1');
}, 20_000);
