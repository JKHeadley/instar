// Meta-verification fixture — concurrency probe 4 of 5 (see fixture-helpers.ts).
import { test } from 'vitest';

import { runProbe, stampWorker } from './fixture-helpers.js';

stampWorker();

test('probe-4 barrier window', async () => {
  await runProbe('probe-4');
}, 20_000);
