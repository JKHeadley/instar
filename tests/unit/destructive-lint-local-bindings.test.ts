import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * `lint-no-direct-destructive` is the funnel guard for destructive git/fs
 * operations: only SafeGitExecutor / SafeFsExecutor may call them directly, so
 * that every delete carries an audit entry.
 *
 * It AST-walks, which already buys it real import resolution — a renamed import
 * (`import { rmSync as nuke }`) is caught where a regex lint would miss it. But
 * the identifier sets were populated ONLY from imports, never from local
 * bindings, so one line of ordinary tidying disabled it for a whole file:
 *
 *     const fsp = fs.promises;
 *     await fsp.rm(p, { recursive: true, force: true });   // exit 0 — invisible
 *
 * `fs.promises.rm` written out IS caught, so the difference between flagged and
 * invisible was a variable. Aliasing a namespace to a short name is idiomatic
 * JavaScript, not an evasion.
 *
 * THE DEFECT tests fail against the shipped behaviour. The CONTROL tests pass
 * under BOTH — this lint fails builds, so flagging correct code would cost more
 * than the gap it closes.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-no-direct-destructive.js');

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'destructive-lint-'));
});
afterAll(() => {
  // Through the funnel, not around it. This test exists because the funnel
  // guard could be walked past; routing its own teardown through SafeFsExecutor
  // is the rule applied to the file that argues for it, and it costs one audit
  // entry per run.
  SafeFsExecutor.safeRmSync(tmp, { operation: 'tests/unit/destructive-lint-local-bindings.test.ts:teardown', recursive: true, force: true });
});

/** Run the lint over one fixture; returns exit code and combined output. */
function lint(source: string, name = 'probe.ts'): { code: number; out: string } {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source, 'utf-8');
  try {
    const out = execFileSync('node', [LINT, file], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('CONTROL — the forms the shipped lint already caught still fire', () => {
  it('flags a plain fs.rmSync', () => {
    // The positive control. Without it, a batch where everything returns 0
    // cannot distinguish "nothing is a violation" from "the lint did not run".
    const { code, out } = lint('import fs from "node:fs";\nexport function w(p: string) { fs.rmSync(p); }\n');
    expect(code).toBe(1);
    expect(out).toContain('SafeFsExecutor');
  });

  it('flags fs.promises.rm written out in full', () => {
    const { code } = lint(
      'import fs from "node:fs";\nexport async function w(p: string) { await fs.promises.rm(p); }\n'
    );
    expect(code).toBe(1);
  });

  it('flags a renamed named import', () => {
    const { code } = lint(
      'import { rmSync as nuke } from "node:fs";\nexport function w(p: string) { nuke(p); }\n'
    );
    expect(code).toBe(1);
  });
});

describe('THE DEFECT — local re-bindings that walked past the funnel guard', () => {
  it('flags a namespace aliased to a local const — the idiomatic case', () => {
    // `const fsp = fs.promises` is ordinary JavaScript. Nobody writing it is
    // trying to get around anything, and that is exactly why it matters.
    const { code, out } = lint([
      'import fs from "node:fs";',
      'const fsp = fs.promises;',
      'export async function w(p: string) { await fsp.rm(p, { recursive: true, force: true }); }',
    ].join('\n'));
    expect(code).toBe(1);
    expect(out).toContain('SafeFsExecutor');
  });

  it('flags a destructive function aliased to a local const', () => {
    const { code } = lint([
      'import fs from "node:fs";',
      'const del = fs.rmSync;',
      'export function w(p: string) { del(p); }',
    ].join('\n'));
    expect(code).toBe(1);
  });

  it('flags destructuring-with-rename off the namespace', () => {
    const { code } = lint([
      'import fs from "node:fs";',
      'const { rmSync: del } = fs;',
      'export function w(p: string) { del(p); }',
    ].join('\n'));
    expect(code).toBe(1);
  });

  it('flags computed access hidden behind a type assertion', () => {
    // `(fs as any)['rmSync'](p)` deletes exactly what `fs.rmSync(p)` deletes.
    // The assertion is erased at runtime; it existed only in the syntax tree.
    const { code } = lint(
      'import fs from "node:fs";\nexport function w(p: string) { (fs as any)["rmSync"](p); }\n'
    );
    expect(code).toBe(1);
  });

  it('resolves a binding declared BELOW the function that uses it', () => {
    // Valid JavaScript, and the reason collection runs to a fixpoint before
    // reporting rather than in one in-order pass.
    const { code } = lint([
      'import fs from "node:fs";',
      'export function w(p: string) { del(p); }',
      'const del = fs.rmSync;',
    ].join('\n'));
    expect(code).toBe(1);
  });

  it('follows a two-step alias chain', () => {
    const { code } = lint([
      'import fs from "node:fs";',
      'const a = fs;',
      'const b = a.promises;',
      'export async function w(p: string) { await b.rm(p); }',
    ].join('\n'));
    expect(code).toBe(1);
  });
});

describe('CONTROL — correct code stays legal (over-block fails builds)', () => {
  it('does not flag a non-destructive fs call', () => {
    expect(lint('import fs from "node:fs";\nexport function r(p: string) { return fs.readFileSync(p, "utf-8"); }\n').code).toBe(0);
  });

  it('does not flag a NON-destructive method on an aliased namespace', () => {
    // The alias itself is not the violation — the destructive method is.
    expect(lint([
      'import fs from "node:fs";',
      'const fsp = fs.promises;',
      'export async function r(p: string) { return await fsp.readFile(p, "utf-8"); }',
    ].join('\n')).code).toBe(0);
  });

  it('does not flag mkdir on an aliased namespace — creating is not deleting', () => {
    expect(lint([
      'import fs from "node:fs";',
      'const fsp = fs.promises;',
      'export async function m(p: string) { await fsp.mkdir(p, { recursive: true }); }',
    ].join('\n')).code).toBe(0);
  });

  it('does not flag the same NAMES on an unrelated object', () => {
    // Resolution is anchored to the fs namespace, never to a method name — an
    // unrelated helper that happens to expose `rmSync` is not the fs module.
    expect(lint([
      'const helpers = { rmSync: (p: string) => p };',
      'const del = helpers.rmSync;',
      'export function r(p: string) { return del(p); }',
    ].join('\n')).code).toBe(0);
  });

  it('does not flag an alias that is never called', () => {
    expect(lint([
      'import fs from "node:fs";',
      'const fsp = fs.promises;',
      'export function count() { return Object.keys(fsp).length; }',
    ].join('\n')).code).toBe(0);
  });
});

describe('a run that parsed nothing must not report clean', () => {
  it('refuses to exit 0 when every scanned file failed to parse', () => {
    // Measured live on 2026-08-15: in a checkout without node_modules the
    // `typescript` require fails for every file, so this guard against
    // unaudited deletes reported clean and exited 0 — with only stderr lines a
    // CI log buries. "No violations found" was a statement about a scan that
    // never happened.
    //
    // Forced deterministically rather than by manipulating the environment: an
    // env-dependent assertion that quietly skips when it cannot create its
    // condition is precisely the failure being fixed here.
    const file = path.join(tmp, 'unparsed.ts');
    fs.writeFileSync(file, 'import fs from "node:fs";\nexport const x = 1;\n', 'utf-8');
    let code = 0;
    let out = '';
    try {
      out = execFileSync('node', [LINT, file], {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: { ...process.env, INSTAR_LINT_FORCE_PARSE_FAILURE: '1' },
      });
    } catch (err: any) {
      code = err.status ?? -1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    expect(out).toContain('failed to parse'); // the condition really was created
    expect(code).toBe(1);
    expect(out).toContain('REFUSING TO REPORT CLEAN');
  });

  it('CONTROL — a file that DOES parse and is clean still exits 0', () => {
    // Pins that the refusal keys on "nothing parsed", not on "a file was
    // scanned". Without this, a refusal that fired on every run would look
    // identical to a correct one on the defect case.
    const { code } = lint('export const x = 1;\n', 'clean.ts');
    expect(code).toBe(0);
  });
});
