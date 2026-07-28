/**
 * Unit tests for the scrape-fixture-realness lint (scripts/lint-scrape-fixture-realness.js).
 *
 * Covers BOTH boundary sides (semantic-correctness standard):
 *  - the SHIPPED registry entry passes against the real repo (conforming case);
 *  - tampered cases FAIL (testName pointed at a non-existent test, the
 *    loadCapturedFixture call removed, a missing/invalid sidecar).
 *
 * The lint's core logic is exported so this runs without shelling out.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — .js script without type declarations; pure JS lint helpers.
import {
  runLint,
  checkFixtures,
  checkTest,
  extractTestBody,
  findUnregisteredParsers,
  SCRAPE_PARSERS,
} from '../../scripts/lint-scrape-fixture-realness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('lint-scrape-fixture-realness — conforming (shipped repo)', () => {
  it('the shipped SCRAPE_PARSERS registry passes against the real repo', () => {
    const result = runLint(REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.passed.length).toBe(SCRAPE_PARSERS.length);
  });

  it('seeds with FrameworkLoginDriver.parseArtifact', () => {
    expect(SCRAPE_PARSERS.some((e: any) => e.parserSymbol === 'FrameworkLoginDriver.parseArtifact')).toBe(true);
  });

  it('extractTestBody finds the named realness test body in the real test file', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'tests/unit/framework-login-driver.test.ts'),
      'utf-8',
    );
    const body = extractTestBody(src, 'parses the REAL wrapped Mac Mini login pane');
    expect(body).not.toBeNull();
    expect(body).toContain('loadCapturedFixture');
    expect(body).toContain('FrameworkLoginDriver.parseArtifact');
    expect(body).toContain('expect(');
  });
});

describe('lint-scrape-fixture-realness — tampered cases fail', () => {
  let tmp: string;
  const slug = 'demo-slug';
  const testFile = 'tests/unit/demo.test.ts';

  // A conforming, self-contained mini-repo we then tamper with.
  function writeConforming(root: string, opts?: { withLoader?: boolean; metaOk?: boolean; testName?: string }) {
    const withLoader = opts?.withLoader ?? true;
    const metaOk = opts?.metaOk ?? true;
    const testName = opts?.testName ?? 'parses the demo capture';

    const fxDir = path.join(root, 'tests', 'fixtures', 'captured', slug);
    fs.mkdirSync(fxDir, { recursive: true });
    fs.writeFileSync(path.join(fxDir, 'sample.txt'), 'visit https://x/y?code=true\nPaste >\n');
    if (metaOk) {
      fs.writeFileSync(
        path.join(fxDir, 'sample.meta.json'),
        JSON.stringify({
          source: 's',
          command: 'c',
          capturedAt: '2026-06-18T01:32:00Z',
          machine: 'm',
          redactions: [],
          note: 'n',
        }),
      );
    }

    const testDir = path.join(root, 'tests', 'unit');
    fs.mkdirSync(testDir, { recursive: true });
    const loaderLine = withLoader
      ? `    const pane = loadCapturedFixture('${slug}', 'sample');`
      : `    const pane = 'visit https://x/y?code=true';`;
    fs.writeFileSync(
      path.join(testDir, 'demo.test.ts'),
      [
        `import { it, expect } from 'vitest';`,
        `it('${testName}', () => {`,
        loaderLine,
        `  const art = Demo.parse(pane, 'k');`,
        `  expect(art).not.toBeNull();`,
        `});`,
      ].join('\n'),
    );
  }

  const entry = {
    parserSymbol: 'Demo.parse',
    fixtureSlug: slug,
    testFile,
    testName: 'parses the demo capture',
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-realness-'));
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/lint-scrape-fixture-realness.test.ts:cleanup' });
  });

  it('a conforming mini-repo passes (control)', () => {
    const root = path.join(tmp, 'ok');
    fs.mkdirSync(root, { recursive: true });
    writeConforming(root);
    expect(checkFixtures(root, slug)).toEqual([]);
    expect(checkTest(root, entry)).toEqual([]);
  });

  it('FAILS when testName points at a non-existent test', () => {
    const root = path.join(tmp, 'badname');
    fs.mkdirSync(root, { recursive: true });
    writeConforming(root);
    const failures = checkTest(root, { ...entry, testName: 'this test does not exist' });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/no test named/);
  });

  it('FAILS when the loadCapturedFixture call is removed', () => {
    const root = path.join(tmp, 'noloader');
    fs.mkdirSync(root, { recursive: true });
    writeConforming(root, { withLoader: false });
    const failures = checkTest(root, entry);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/loadCapturedFixture/);
  });

  it('FAILS when the sidecar is missing', () => {
    const root = path.join(tmp, 'nometa');
    fs.mkdirSync(root, { recursive: true });
    writeConforming(root, { metaOk: false });
    const failures = checkFixtures(root, slug);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/missing sidecar/);
  });

  it('FAILS when capturedAt is not a parseable ISO date', () => {
    const root = path.join(tmp, 'baddate');
    fs.mkdirSync(root, { recursive: true });
    writeConforming(root);
    const fxDir = path.join(root, 'tests', 'fixtures', 'captured', slug);
    fs.writeFileSync(
      path.join(fxDir, 'sample.meta.json'),
      JSON.stringify({
        source: 's',
        command: 'c',
        capturedAt: 'not-a-date',
        machine: 'm',
        redactions: [],
        note: 'n',
      }),
    );
    const failures = checkFixtures(root, slug);
    expect(failures.join('\n')).toMatch(/not a parseable ISO-8601 date/);
  });

  it('FAILS when the fixture dir is missing entirely', () => {
    const root = path.join(tmp, 'nodir');
    fs.mkdirSync(root, { recursive: true });
    const failures = checkFixtures(root, slug);
    expect(failures.join('\n')).toMatch(/fixture dir missing/);
  });
});

describe('lint-scrape-fixture-realness — register-or-justify warning is non-blocking', () => {
  it('findUnregisteredParsers returns a list (signal only, never affects exit code)', () => {
    const found = findUnregisteredParsers(REPO_ROOT);
    expect(Array.isArray(found)).toBe(true);
    // Whatever it finds, the shipped lint still exits 0 (warnings don't block).
    expect(runLint(REPO_ROOT).exitCode).toBe(0);
  });
});
