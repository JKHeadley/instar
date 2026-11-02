/**
 * Pure helpers for scripts/build-locked-proof.mjs (docs/specs/desktop-locked-screen.md,
 * phase 3 "test build"). Kept separate so the rewrite is unit-tested without a build.
 *
 * The test build is the ONLY way a macOS version without recorded P12/P15 passes
 * reaches the proven-versions table, and it only ever does so in a scratch copy.
 */

/** The marker every test-build row carries instead of a proof path. */
export const PROOF_IN_PROGRESS = 'PROOF-RUN-IN-PROGRESS';

/** The literal the committed table is declared with. Exactly one must exist. */
const TABLE_RE = /export const PROVEN_MACOS_VERSIONS: readonly DesktopProvenVersion\[\] = Object\.freeze\(\[([\s\S]*?)\]\);/g;

/** `<base>-lockedproof.<n>`; base must be a plain dotted release version. */
export function proofVersion(base, n) {
  if (typeof base !== 'string' || !/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error(`package version "${base}" is not a plain release version (x.y.z)`);
  }
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`build number must be a positive integer, got ${n}`);
  return `${base}-lockedproof.${n}`;
}

export function parseOsMajor(value) {
  const major = Number.parseInt(String(value).trim().split('.')[0] ?? '', 10);
  if (!Number.isSafeInteger(major) || major < 11 || major > 99) {
    throw new Error(`not a macOS major version: "${value}"`);
  }
  return major;
}

/**
 * Return the source of DesktopProvenVersions.ts with one test row for `osMajor`
 * added in front of the committed rows. Refuses when the declaration is not
 * found exactly once, or when that version is already in the table.
 */
export function rewriteProvenTable(source, { osMajor, version }) {
  const matches = [...source.matchAll(TABLE_RE)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one PROVEN_MACOS_VERSIONS declaration, found ${matches.length}`);
  }
  const [whole, body] = matches[0];
  if (new RegExp(`osMajor:\\s*${osMajor}\\b`).test(body)) {
    throw new Error(`macOS ${osMajor} is already in the committed table; no test build is needed`);
  }
  const marker = `${PROOF_IN_PROGRESS} ${version}`;
  const row = `{ osMajor: ${osMajor}, p12: '${marker}', p15: '${marker}', refuse: [] }`;
  const rest = body.trim();
  const next = whole.replace(`([${body}])`, `([${row}${rest ? `, ${rest}` : ''}])`);
  return source.replace(whole, next);
}

/**
 * Check a table's rows against the proof records on disk. A committed row must
 * cite, for p12 and p15, a file under docs/proofs/desktop-locked-screen/ that
 * exists (an `#anchor` is allowed), and never the test-build marker.
 * Returns a list of problems (empty when every row is backed).
 */
export function unprovenRows(rows, fileExists) {
  const problems = [];
  for (const row of rows) {
    for (const gate of ['p12', 'p15']) {
      const cite = String(row[gate] ?? '');
      const file = cite.split('#')[0];
      if (cite.includes(PROOF_IN_PROGRESS)) problems.push(`macOS ${row.osMajor} ${gate}: test-build marker in the committed table`);
      else if (!file.startsWith('docs/proofs/desktop-locked-screen/') || file.includes('..')) problems.push(`macOS ${row.osMajor} ${gate}: "${cite}" is not a proof record path`);
      else if (!fileExists(file)) problems.push(`macOS ${row.osMajor} ${gate}: proof record ${file} does not exist`);
    }
  }
  return problems;
}
