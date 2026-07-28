// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup of a
//   mkdtempSync directory this test created; no production path is touched.

/**
 * Lint: a raw NUL (0x00) byte in a text source file makes the ENTIRE file
 * invisible to `grep`.
 *
 * Why it exists
 * -------------
 * `grep` classifies a file as binary if it contains a NUL byte, and on a
 * binary file it emits NOTHING — not a match, not a "Binary file X matches"
 * line under `-c`, not even a `0`. So every grep-based audit over `src/`
 * silently SKIPS that file, and the empty result reads as "the thing I
 * searched for is absent."
 *
 * That is absence rendering as presence: the instrument cannot say "I could
 * not look here," so "I could not look" is indistinguishable from
 * "nothing is wrong."
 *
 * Discovered 2026-07-26 while auditing whether a decision-quality grade could
 * be retracted. A repo-wide search over `src/` returned one unrelated
 * subsystem, and that near-empty result was about to be written up as a
 * finding. In fact the search had skipped 22 source files — among them
 * `blockerSettleAuthority.ts` (the true-blocker settle gate),
 * `SessionOwnership.ts`, `GreenPrAutoMerger.ts`,
 * `PermissionPromptAutoResolver.ts` (an always-on safety floor) and, most
 * pointedly, `StandardsEnforcementAuditor.ts` — the module that audits
 * whether our standards have structural guards was itself invisible to the
 * standard search instrument.
 *
 * The bytes were never corruption. Every one was a deliberate composite-key
 * or hash separator written as a literal byte instead of an escape:
 *
 *     const key = `${row.model}<a literal 0x00 byte>${row.framework}`;
 *
 * The delimiter choice is sound. Writing it raw is what hides the file. The
 * six-character escape (backslash, u, 0, 0, 0, 0) produces the IDENTICAL
 * runtime string and keeps the file text.
 *
 * `git grep` does NOT catch this and cannot be relied on to: git only sniffs
 * the first 8000 bytes for NUL, so a separator deeper in the file leaves
 * `git grep` working while plain `grep` goes silent — the two instruments
 * disagree, which is what makes the failure so hard to notice.
 *
 * The rule
 * --------
 * No text source file may contain a raw 0x00 byte. Use the six-character
 * escape, which is valid and unambiguous in string, template AND regex
 * contexts (unlike the shorter form, a legacy octal escape when followed by
 * a digit).
 *
 * There are no exemptions, because there is no case that needs one: any
 * runtime NUL a file legitimately wants is expressible as an escape.
 *
 * Scope note: other raw control bytes (ESC 0x1b, BEL 0x07, 0x1f) also appear
 * in a few hostile-input test fixtures. They are deliberately NOT covered
 * here — verified empirically that they do NOT make grep skip a file, so
 * they do not cause this defect. Escaping them would be cosmetic, and a lint
 * should enforce exactly the failure it is named for.
 *
 * Authoring note: this file deliberately never types the escape inline.
 * Writing it by hand is how the defect propagates — the first draft of this
 * very lint shipped five raw NUL bytes and hid itself from grep. Both the
 * raw byte and the escape TEXT are constructed from char codes below.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..');

/** The forbidden byte itself. */
const RAW_NUL = String.fromCharCode(0);

/** The six literal characters that should appear in source instead. */
const ESCAPE_TEXT = String.fromCharCode(92) + 'u0000';

/** Roots that hold hand-authored text. Build output and deps are excluded. */
const SCAN_ROOTS = ['src', 'tests', 'docs', 'scripts', '.github'];

/** Extensions whose files are text by definition — a NUL in them is a defect. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.sh',
  '.yml',
  '.yaml',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

function collectTextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // @silent-fallback-ok: an unreadable dir is not a NUL finding
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // @silent-fallback-ok: a vanished entry is not a NUL finding
      }
      if (st.isDirectory()) walk(full);
      else if (TEXT_EXTENSIONS.has(extname(entry))) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The detector, isolated so the self-test below exercises the SAME code path
 * the lint uses. Reads latin1 so every byte survives the decode.
 */
function containsRawNul(absPath: string): boolean {
  try {
    return readFileSync(absPath, 'latin1').includes(RAW_NUL);
  } catch {
    return false; // @silent-fallback-ok: unreadable file reported by other lints
  }
}

describe('no raw NUL bytes in text source', () => {
  it('the detector actually detects — a NUL file is flagged, an escaped file is not', () => {
    // Guard against a dead check. A lint that has never said anything is
    // output-identical to a lint that cannot say anything, so this makes the
    // detector REFUSE something concrete on every run.
    const dir = mkdtempSync(join(tmpdir(), 'nul-lint-selftest-'));
    try {
      const escaped = join(dir, 'escaped.ts');
      const raw = join(dir, 'raw.ts');
      writeFileSync(escaped, 'export const key = `${a}' + ESCAPE_TEXT + '${b}`;\n');
      writeFileSync(raw, 'export const key = `${a}' + RAW_NUL + '${b}`;\n');

      expect(containsRawNul(escaped)).toBe(false);
      expect(containsRawNul(raw)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the escape is behaviour-preserving — it denotes exactly the raw byte', () => {
    // Why the fix is safe: the six-character escape and the raw byte are the
    // same one-character string. Only the file's text-ness differs.
    const decoded = JSON.parse(`"${ESCAPE_TEXT}"`) as string;
    expect(decoded).toBe(RAW_NUL);
    expect(decoded.length).toBe(1);
    expect(decoded.charCodeAt(0)).toBe(0);
  });

  it('no tracked text file contains a raw NUL byte', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectTextFiles(join(REPO_ROOT, root))) {
        if (containsRawNul(file)) offenders.push(relative(REPO_ROOT, file));
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `\n${offenders.length} file(s) contain a raw NUL (0x00) byte and are therefore ` +
            `INVISIBLE to grep — every grep-based audit silently skips them and reports ` +
            `"not found":\n\n  ${offenders.join('\n  ')}\n\n` +
            `Fix: replace the raw byte with the six-character escape ${ESCAPE_TEXT}. ` +
            `The runtime string is identical; only the file's text-ness changes.\n`,
    ).toEqual([]);
  });

  it('scans a non-trivial number of files (the scan itself is not silently empty)', () => {
    // A scan that finds nothing because it looked nowhere would pass the test
    // above forever. Assert the corpus is real.
    const total = SCAN_ROOTS.reduce(
      (n, root) => n + collectTextFiles(join(REPO_ROOT, root)).length,
      0,
    );
    expect(total).toBeGreaterThan(500);
  });
});
