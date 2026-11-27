/**
 * Vite alias that routes `import request from 'supertest'` in test files to
 * tests/setup/supertest-with-retry.ts. Only the bare specifier matches, so the
 * wrapper's own `supertest/index.js` import reaches the real package.
 */
export const supertestRetryAlias = {
  find: /^supertest$/,
  replacement: new URL('./supertest-with-retry.ts', import.meta.url).pathname,
};
