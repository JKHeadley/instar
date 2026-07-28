// Meta-verification fixture — concurrency probe 2 of 5 (see fixture-helpers.ts).
import { test } from 'vitest';

import { runProbe, stampWorker } from './fixture-helpers.js';

stampWorker();

test('probe-2 barrier window', async () => {
  await runProbe('probe-2');
}, 20_000);
