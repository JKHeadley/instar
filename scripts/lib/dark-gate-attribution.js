/**
 * dark-gate-attribution.js — the path-attribution + registry-extraction core
 * shared by scripts/lint-dev-agent-dark-gate.js (assertion C) and its golden-path
 * drift-canary test. Extracted so there is ONE attributor implementation: the
 * lint and the test agree by construction (the test asserts THIS resolver
 * reproduces a hand-authored map — never the resolver's own output).
 */

import fs from 'node:fs';

/** Strip a `//` line comment; return null if the line is a pure comment line. */
export function codeOnly(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return null; // comment line — no code
  }
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

/**
 * Does a code-stripped line contain a `{` or `}` inside a string or template
 * literal? codeOnly() does not strip string contents, so such a brace would
 * desync the depth counter.
 */
export function braceInString(code) {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; } // skip escaped char
      if (ch === quote) { inStr = false; quote = ''; }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      quote = ch;
    }
    if (inStr && (ch === '{' || ch === '}')) return true;
  }
  return false;
}

/**
 * Attribute every `enabled: false` line in a ConfigDefaults.ts to a dotted config
 * path by brace-tracking from the top of the SHARED_DEFAULTS object literal.
 * Returns { paths: [{ line, dottedPath }], error }.
 */
export function attributeEnabledFalsePaths(absPath) {
  const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
  const startIdx = lines.findIndex((l) => /const\s+SHARED_DEFAULTS\b[^=]*=\s*{/.test(l));
  if (startIdx < 0) {
    return { paths: [], error: 'could not locate `const SHARED_DEFAULTS = {` in ConfigDefaults.ts' };
  }

  // Stack of { key } — key is null for an anonymous `{` (array element object
  // etc.). depth starts at 0; the SHARED_DEFAULTS `{` takes it to 1 (the root
  // object body lives at depth 1).
  const stack = [];
  let depth = 0;
  const results = [];
  const ENABLED_FALSE = /(["']?)enabled\1\s*:\s*false\b/;
  const KEY_LINE = /^\s*(["']?)([A-Za-z_$][\w$-]*)\1\s*:/;

  for (let i = startIdx; i < lines.length; i++) {
    const code = codeOnly(lines[i]);
    if (code === null) continue; // pure comment line

    if (braceInString(code)) {
      return {
        paths: [],
        error: `brace-in-string in defaults block can desync path attribution (line ${i + 1}) — split the value or extend the parser`,
      };
    }

    const isEnabledFalse = ENABLED_FALSE.test(code);
    const keyMatch = code.match(KEY_LINE);
    const keyCandidate = keyMatch ? keyMatch[2] : null;

    if (isEnabledFalse) {
      const dottedPath = stack.map((s) => s.key).filter(Boolean).join('.') + '.enabled';
      results.push({ line: i + 1, dottedPath });
    }

    let firstOpenOnLine = true;
    for (const ch of code) {
      if (ch === '{') {
        if (firstOpenOnLine && keyCandidate && depth >= 1) {
          stack.push({ key: keyCandidate });
        } else {
          stack.push({ key: null });
        }
        firstOpenOnLine = false;
        depth++;
      } else if (ch === '}') {
        depth--;
        stack.pop();
        if (depth <= 0) {
          return { paths: results, error: null };
        }
      }
    }
  }
  return { paths: results, error: null };
}

const VALID_CATEGORIES = new Set([
  'destructive',
  'optional-integration',
  'cost-bearing',
  'structural-stub',
  'deliberate-fleet-default',
]);

export { VALID_CATEGORIES };

/**
 * Extract configPath literals + exclusion entries from a devGatedFeatures.ts.
 * The file is hand-authored with a stable shape; the lint runs as plain JS
 * (importing the TS registry directly won't work), so we regex the source.
 */
export function extractRegistry(absPath) {
  const src = fs.readFileSync(absPath, 'utf-8');
  const configPathOf = (arrName) => {
    const m = src.match(new RegExp(`export const ${arrName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    if (!m) return [];
    const body = m[1];
    const paths = [];
    const re = /configPath:\s*(['"])([^'"]+)\1/g;
    let mm;
    while ((mm = re.exec(body)) !== null) paths.push(mm[2]);
    return paths;
  };
  const exclBody = (() => {
    const m = src.match(/export const DARK_GATE_EXCLUSIONS[^=]*=\s*\[([\s\S]*?)\n\];/);
    return m ? m[1] : '';
  })();
  const exclusionEntries = [];
  const entryRe = /\{\s*configPath:\s*(['"])([^'"]+)\1\s*,\s*category:\s*(['"])([^'"]+)\3\s*,\s*reason:\s*(['"])((?:[^'"\\]|\\.)*)\5\s*,?\s*\}/g;
  let em;
  while ((em = entryRe.exec(exclBody)) !== null) {
    exclusionEntries.push({ configPath: em[2], category: em[4], reason: em[6] });
  }
  return {
    gatedPaths: configPathOf('DEV_GATED_FEATURES'),
    exclusionPaths: configPathOf('DARK_GATE_EXCLUSIONS'),
    exclusionEntries,
  };
}
