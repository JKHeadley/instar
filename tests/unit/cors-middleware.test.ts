import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates CORS configuration is correct.
 * Previously had 'http://localhost:*' which is not a valid CORS origin pattern.
 */
describe('CORS middleware configuration', () => {
  it('does not use invalid wildcard origin patterns', () => {
    const middlewareSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/middleware.ts'),
      'utf-8'
    );
    // http://localhost:* is not a valid origin — browsers will reject it
    expect(middlewareSource).not.toContain("'http://localhost:*'");
    expect(middlewareSource).not.toContain('"http://localhost:*"');
  });

  it('sets Access-Control-Allow-Origin header', () => {
    const middlewareSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/middleware.ts'),
      'utf-8'
    );
    expect(middlewareSource).toContain('Access-Control-Allow-Origin');
  });

  it('handles OPTIONS preflight requests', () => {
    const middlewareSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/middleware.ts'),
      'utf-8'
    );
    expect(middlewareSource).toContain("req.method === 'OPTIONS'");
    expect(middlewareSource).toContain('204');
  });
});
