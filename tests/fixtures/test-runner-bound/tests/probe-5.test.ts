// Meta-verification fixture — concurrency probe 5 of 5 (see fixture-helpers.ts).
import { test } from 'vitest';

import { runProbe, stampWorker } from './fixture-helpers.js';

stampWorker();

test('probe-5 barrier window', async () => {
  await runProbe('probe-5');
}, 20_000);
