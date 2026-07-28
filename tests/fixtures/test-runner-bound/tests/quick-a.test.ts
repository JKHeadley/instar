// Meta-verification fixture — trivial fast test (see fixture-helpers.ts).
import { expect, test } from 'vitest';

import { stampWorker } from './fixture-helpers.js';

stampWorker();

test('quick-a', () => {
  expect(1 + 1).toBe(2);
});
