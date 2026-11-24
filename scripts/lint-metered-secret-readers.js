#!/usr/bin/env node
/**
 * lint-metered-secret-readers.js — one named reader for pay-per-use keys
 * (docs/specs/gemini-payg-metered-lane.md §4.1).
 *
 * A metered key (src/core/meteredSecrets.ts: `gemini_api_key_payg`, `metered_*`) bills
 * real money per token. Exactly one module may READ one by name:
 * `src/providers/metered/gemini-api/geminiApiKeyReader.ts`. This lint fails the build
 * when a metered name is READ anywhere else in src/ or scripts/:
 *
 *   - passed to a vault read: `.get('<name>')`, `getSecret(...)`, `readSecret(...)`
 *   - handed to the secret-get script: `secret-get.mjs <name>`
 *   - read from the environment under a metered name: `process.env.<name>`
 *
 * A bare mention of the name (a keyRef label, a doc string, a refusal list) is not a
 * read and is allowed: the label `metered_openrouter_bench` in a caps record names a
 * key, it does not obtain one.
 *
 * Honest limit (stated in the spec): this matches NAMED reads. Whole-vault consumers
 * (the sync payload, `--names`, the boot key list) enumerate every key; a unit test pins
 * that each emits names or encrypted payloads only.
 *
 * Exit 0 = clean. Exit 1 = at least one offending site (printed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The one reader, the list module, the sync filter, and this lint itself. */
export const ALLOWED_READERS = [
  path.join('src', 'providers', 'metered', 'gemini-api', 'geminiApiKeyReader.ts'),
  path.join('src', 'core', 'meteredSecrets.ts'),
  path.join('src', 'core', 'SecretSync.ts'),
  path.join('scripts', 'lint-metered-secret-readers.js'),
  path.join('src', 'templates', 'scripts', 'secret-get.mjs'),
];

const NAME = String.raw`(?:gemini_api_key_payg|metered_[A-Za-z0-9_]+)`;
const QUOTED = String.raw`['"\x60]${NAME}(?:\.[A-Za-z0-9_.]+)?['"\x60]`;

/** The exported constants that name a metered key; a read through them is still a read. */
const CONST_NAME = String.raw`(?:GEMINI_PAYG_SECRET_NAME|METERED_SECRET_NAMES\[[^\]]*\])`;

export const READ_PATTERNS = [
  { id: 'vault-get-const', re: new RegExp(String.raw`\.(?:get|getSecret|read|readSecret|getValue)\(\s*${CONST_NAME}`) },
  { id: 'secret-helper-const', re: new RegExp(String.raw`\b(?:getSecret|readSecret|secretGet|resolveSecret)\(\s*${CONST_NAME}`) },
  { id: 'env-read-const', re: new RegExp(String.raw`process\.env\[\s*${CONST_NAME}\s*\]`) },
  { id: 'vault-get', re: new RegExp(String.raw`\.(?:get|getSecret|read|readSecret|getValue)\(\s*${QUOTED}`) },
  { id: 'secret-get-helper', re: new RegExp(String.raw`\b(?:getSecret|readSecret|secretGet|resolveSecret)\(\s*${QUOTED}`) },
  { id: 'secret-get-script', re: new RegExp(String.raw`secret-get(?:\.mjs)?['"\x60]?\s*,?\s*['"\x60]?${NAME}\b`) },
  { id: 'env-read', re: new RegExp(String.raw`process\.env(?:\.${NAME}\b|\[\s*${QUOTED}\s*\])`) },
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(ts|js|mjs|cjs|sh)$/.test(e.name) && !/\.test\.(ts|js|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Scan text; returns offending { line, id, text } entries. Pure, for tests. */
export function scanText(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of READ_PATTERNS) {
      if (p.re.test(lines[i])) {
        hits.push({ line: i + 1, id: p.id, text: lines[i].trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

/** Scan the repo (or a given root); returns offenders with repo-relative paths. */
export function scanRepo(root = ROOT) {
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))];
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    if (ALLOWED_READERS.includes(rel)) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/gemini_api_key_payg|metered_|GEMINI_PAYG_SECRET_NAME|METERED_SECRET_NAMES/.test(text)) continue;
    for (const h of scanText(text)) offenders.push({ file: rel, ...h });
  }
  return offenders;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const offenders = scanRepo();
  if (offenders.length > 0) {
    console.error('lint-metered-secret-readers: a metered (pay-per-use) key is read outside its one door:');
    for (const o of offenders) console.error(`  ${o.file}:${o.line} [${o.id}] ${o.text}`);
    console.error('Only src/providers/metered/gemini-api/geminiApiKeyReader.ts may read a metered key (gemini-payg-metered-lane §4.1).');
    process.exit(1);
  }
  console.log('lint-metered-secret-readers: OK');
}
