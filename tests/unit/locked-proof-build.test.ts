import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROVEN_MACOS_VERSIONS } from '../../src/core/DesktopProvenVersions.js';
// @ts-expect-error — plain .mjs script helper, no type declarations
import { PROOF_IN_PROGRESS, parseOsMajor, proofVersion, rewriteHelperRoot, rewriteProvenTable, unprovenRows } from '../../scripts/lib/locked-proof-build.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const TABLE = path.join(ROOT, 'src/core/DesktopProvenVersions.ts');

describe('committed proven-versions table', () => {
  it('has no row without a recorded P12 and P15 proof on disk', () => {
    const problems = unprovenRows(PROVEN_MACOS_VERSIONS, (file: string) => fs.existsSync(path.join(ROOT, file)));
    expect(problems).toEqual([]);
  });

  it('the check fails a row with the test-build marker, a stray path or a missing record', () => {
    const exists = (file: string) => file === 'docs/proofs/desktop-locked-screen/macos-26-2026-11-03.md';
    expect(unprovenRows([{ osMajor: 26, p12: `${PROOF_IN_PROGRESS} 1.3.1-lockedproof.1`, p15: 'x', refuse: [] }], exists)).toHaveLength(2);
    expect(unprovenRows([{ osMajor: 26, p12: 'docs/proofs/desktop-locked-screen/missing.md#p12', p15: 'docs/proofs/desktop-locked-screen/macos-26-2026-11-03.md#p15', refuse: [] }], exists))
      .toEqual(['macOS 26 p12: proof record docs/proofs/desktop-locked-screen/missing.md does not exist']);
    expect(unprovenRows([{ osMajor: 26, p12: 'docs/proofs/desktop-locked-screen/../../x.md', p15: 'docs/proofs/desktop-locked-screen/macos-26-2026-11-03.md#p15', refuse: [] }], exists)).toHaveLength(1);
    expect(unprovenRows([{ osMajor: 26, p12: 'docs/proofs/desktop-locked-screen/macos-26-2026-11-03.md#p12', p15: 'docs/proofs/desktop-locked-screen/macos-26-2026-11-03.md#p15', refuse: [] }], exists)).toEqual([]);
  });
});

describe('locked-proof test build helpers', () => {
  it('moves the kept helper folder in the real retention source, and only that', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/core/DesktopHelperRetention.ts'), 'utf8');
    const moved = rewriteHelperRoot(source, 'desktop-helper-proof4');
    expect(moved).toContain("path.join(os.homedir(), '.instar', 'desktop-helper-proof4')");
    expect(moved).not.toContain("path.join(os.homedir(), '.instar', 'desktop-helper')");
    expect(moved.length - source.length).toBe('-proof4'.length);
  });

  it('refuses a helper folder that could reach the locked store or leave ~/.instar', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/core/DesktopHelperRetention.ts'), 'utf8');
    for (const bad of ['desktop-helper', 'desktop-helper/locked', '../desktop-helper-x', 'other', '']) {
      expect(() => rewriteHelperRoot(source, bad)).toThrow(/desktop-helper-<name>/);
    }
    expect(() => rewriteHelperRoot('nothing here', 'desktop-helper-x')).toThrow(/exactly one/);
  });

  it('versions the build as <release>-lockedproof.<n> and refuses anything else', () => {
    expect(proofVersion('1.3.1607', 2)).toBe('1.3.1607-lockedproof.2');
    expect(() => proofVersion('1.3.1607-lockedproof.1', 2)).toThrow(/plain release version/);
    expect(() => proofVersion('1.3.1607', 0)).toThrow(/positive integer/);
  });

  it('parses a macOS version into its major', () => {
    expect(parseOsMajor('26.1\n')).toBe(26);
    expect(parseOsMajor('15')).toBe(15);
    expect(() => parseOsMajor('abc')).toThrow();
    expect(() => parseOsMajor('9.3')).toThrow();
  });

  it('adds exactly one in-progress row to the real committed source', () => {
    const source = fs.readFileSync(TABLE, 'utf8');
    const out = rewriteProvenTable(source, { osMajor: 26, version: '1.3.1607-lockedproof.1' });
    const line = out.split('\n').find((l: string) => l.startsWith('export const PROVEN_MACOS_VERSIONS'))!;
    expect(line).toContain(`{ osMajor: 26, p12: '${PROOF_IN_PROGRESS} 1.3.1607-lockedproof.1', p15: '${PROOF_IN_PROGRESS} 1.3.1607-lockedproof.1', refuse: [] }`);
    // Everything else in the file is unchanged.
    expect(out.replace(line, '')).toBe(source.replace(source.split('\n').find((l: string) => l.startsWith('export const PROVEN_MACOS_VERSIONS'))!, ''));
    // The marker row passes provenVersion's non-empty check, so the test build admits it.
    expect(out).toMatch(/p12: 'PROOF-RUN-IN-PROGRESS/);
  });

  it('keeps committed rows and refuses a version that is already proven', () => {
    const src = "export const PROVEN_MACOS_VERSIONS: readonly DesktopProvenVersion[] = Object.freeze([{ osMajor: 15, p12: 'a', p15: 'b', refuse: [] }]);\n";
    expect(rewriteProvenTable(src, { osMajor: 26, version: 'v' })).toContain("[{ osMajor: 26, p12: 'PROOF-RUN-IN-PROGRESS v', p15: 'PROOF-RUN-IN-PROGRESS v', refuse: [] }, { osMajor: 15,");
    expect(() => rewriteProvenTable(src, { osMajor: 15, version: 'v' })).toThrow(/already in the committed table/);
    expect(() => rewriteProvenTable('nothing here', { osMajor: 26, version: 'v' })).toThrow(/exactly one/);
  });

  it('the script dry run names the row and leaves the committed table untouched', () => {
    const before = crypto.createHash('sha256').update(fs.readFileSync(TABLE)).digest('hex');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-locked-proof.mjs'), '--dry-run', '--os-major', '26', '--n', '3'],
      { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/-lockedproof\.3 at [0-9a-f]{12} admits macOS 26/);
    expect(out).toContain("osMajor: 26, p12: 'PROOF-RUN-IN-PROGRESS");
    expect(crypto.createHash('sha256').update(fs.readFileSync(TABLE)).digest('hex')).toBe(before);
  });

  it('builds with the release signing key removed from the environment', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/build-locked-proof.mjs'), 'utf8');
    for (const key of ['INSTAR_RELEASE_PRIVATE_KEY_PEM', 'INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH']) expect(src).toContain(`delete buildEnv.${key};`);
    expect(src).toMatch(/execFileSync\('npm', \['run', 'build'\], \{[^}]*env: buildEnv/);
  });

  it('the script refuses an output directory inside the checkout', () => {
    let failed = false;
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-locked-proof.mjs'), '--os-major', '26', '--out', path.join(ROOT, 'proof-out')],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      failed = true;
      expect(String((err as { stderr?: string }).stderr)).toMatch(/outside this checkout/);
    }
    expect(failed).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'proof-out'))).toBe(false);
  });
});
