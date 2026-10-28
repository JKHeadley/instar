/**
 * `supertest`, with the suite-wide connect retry installed (see
 * supertest-connect-retry.ts).
 *
 * The vitest configs alias the bare specifier `supertest` to this module, so a
 * test file that imports Supertest gets exactly the patched module it got when
 * tests/vitest-setup.ts imported and patched Supertest for every file. The
 * difference is cost: Supertest (and superagent beneath it) took ~100 ms to load
 * and was loaded into all ~2,500 unit files, while only ~470 test files use it.
 *
 * The real package is imported by its file path so the alias does not resolve
 * back to this module.
 */
import supertest from 'supertest/index.js';
import { installSupertestConnectRetry } from './supertest-connect-retry.js';

installSupertestConnectRetry((supertest as unknown as {
  Test: { prototype: Parameters<typeof installSupertestConnectRetry>[0] };
}).Test.prototype);

export default supertest;
