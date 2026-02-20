import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Config version detection', () => {
  it('health endpoint uses config version not hardcoded', async () => {
    // Read the routes source to verify no hardcoded version
    const routesSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/routes.ts'),
      'utf-8'
    );
    // Should NOT contain hardcoded '0.1.0'
    expect(routesSource).not.toContain("version: '0.1.0'");
    // Should reference config version
    expect(routesSource).toContain('ctx.config.version');
  });

  it('package.json version matches CLI version', () => {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'package.json'),
      'utf-8'
    ));
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'src/cli.ts'),
      'utf-8'
    );
    // Extract version from .version() call in cli.ts
    const match = cliSource.match(/\.version\('([^']+)'\)/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe(pkg.version);
  });
});
