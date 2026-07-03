// Meta-verification fixture — concurrency probe 3 of 5 (see fixture-helpers.ts).
import { test } from 'vitest';

import { runProbe, stampWorker } from './fixture-helpers.js';

stampWorker();

test('probe-3 barrier window', async () => {
  await runProbe('probe-3');
}, 20_000);
