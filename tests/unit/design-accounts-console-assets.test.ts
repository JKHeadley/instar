import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS_CONSOLE_ASSETS, readAccountsConsoleAsset } from '../design/harness/accountsConsoleAssets.js';

function moduleClosure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const dependency = path.posix.normalize(`${path.posix.dirname(file)}/${match[1]}`);
    expect(fs.statSync(dependency).isFile(), `${file}: ${dependency}`).toBe(true);
    moduleClosure(dependency, seen);
  }
  return seen;
}
describe('closed production console asset map', () => {
  it('matches the actual full console module closure and local stylesheet/font/image entries exactly', () => {
    const expected = moduleClosure('dashboard/console/console.js');
    for (const file of ['dashboard/console/index.html', 'dashboard/console/console.css', 'dashboard/logo.png', 'dashboard/favicon.png']) expected.add(file);
    const css = fs.readFileSync('dashboard/console/console.css', 'utf8');
    for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      expect(match[1]).not.toMatch(/^(?:https?:|data:|\/)/);
      expected.add(`dashboard/console/${match[1]}`);
    }
    expect(new Set(ACCOUNTS_CONSOLE_ASSETS.map(asset => asset.file))).toEqual(expected);
    expect(new Set(ACCOUNTS_CONSOLE_ASSETS.map(asset => asset.route)).size).toBe(ACCOUNTS_CONSOLE_ASSETS.length);
    for (const asset of ACCOUNTS_CONSOLE_ASSETS) {
      expect(asset.file).not.toContain('..'); expect(asset.route).toMatch(/^\/dashboard\//);
      expect(readAccountsConsoleAsset(asset)).toEqual(fs.readFileSync(asset.file));
      expect(Object.isFrozen(asset)).toBe(true);
    }
  });
  it('never maps an unlisted sibling, application source or fixture state as a public asset', () => {
    const routes = new Set(ACCOUNTS_CONSOLE_ASSETS.map(asset => asset.route));
    for (const url of ['/src/server/routes.ts', '/tests/design/seeds/accounts.json', '/dashboard/console/new-page.js', '/dashboard/console/fonts/LICENSE.md']) expect(routes.has(url)).toBe(false);
  });
});
