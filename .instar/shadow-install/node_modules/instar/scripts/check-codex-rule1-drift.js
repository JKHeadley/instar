#!/usr/bin/env node
/**
 * check-codex-rule1-drift.js — spec 12 drift-detection CI gate.
 *
 * Asserts that src/providers/adapters/openai-codex/config.ts has NOT
 * drifted back to pre-spec-12 behavior:
 *
 *   1. The "Agent SDK credit pot analog" comment block (which framed
 *      API-key auth as ACCEPTABLE) must not be present. The replacement
 *      framing is "FORBIDDEN as a routine path per spec 12 Rule 1."
 *   2. configFromEnv must NOT read OPENAI_API_KEY into the config.
 *      Phase A migration explicitly removes that line.
 *   3. The apiKey field must be paired with @deprecated + @internal
 *      JSDoc tags (Phase A) OR narrowed to `apiKey?: never` (Phase B+).
 *      Plain `apiKey?: string` without deprecation marker is drift.
 *
 * Closes the "spec approved, code still says the opposite" failure
 * mode that spec 12 explicitly calls out.
 *
 * Exit codes:
 *   0 — config.ts is compliant
 *   1 — drift detected (with detailed reason)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'src/providers/adapters/openai-codex/config.ts');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[codex-rule1-drift] config.ts not found at ${CONFIG_PATH}`);
  process.exit(1);
}

const source = fs.readFileSync(CONFIG_PATH, 'utf-8');
const failures = [];

// ─── 1. Forbidden framing-comment string ─────────────────────────────────
if (source.includes('Agent SDK credit pot analog')) {
  failures.push(
    'config.ts still contains the string "Agent SDK credit pot analog" — ' +
    'pre-spec-12 framing that treats API-key auth as ACCEPTABLE. ' +
    'Replace the comment block with a reference to spec 12 Rule 1 ' +
    '(which forbids API-key auth as a routine path).',
  );
}

// ─── 2. configFromEnv must not read OPENAI_API_KEY ───────────────────────
// Phase A removed the `apiKey: env['OPENAI_API_KEY']` line. Match the
// assignment shape so the surrounding comment ABOUT the env var (which
// is documentation, not behavior) doesn't false-positive.
const envReadPatterns = [
  /apiKey\s*:\s*env\[\s*['"]OPENAI_API_KEY['"]\s*\]/,
  /apiKey\s*:\s*env\.OPENAI_API_KEY\b/,
  /apiKey\s*:\s*process\.env\[\s*['"]OPENAI_API_KEY['"]\s*\]/,
  /apiKey\s*:\s*process\.env\.OPENAI_API_KEY\b/,
];
for (const pat of envReadPatterns) {
  if (pat.test(source)) {
    failures.push(
      `config.ts's configFromEnv still reads OPENAI_API_KEY (matched ${pat.source}). ` +
      'Spec 12 Phase A migration requires this read to be removed. The credential ' +
      'validator (credentials.ts) handles env-var detection at adapter init via warning/refusal.',
    );
    break; // one match is enough
  }
}

// ─── 3. apiKey field must be deprecated (Phase A) or never (Phase B+) ────
// Find the apiKey field declaration in the OpenAiCodexConfig interface.
// Acceptable forms:
//   (Phase A) apiKey?: string  WITH @deprecated AND @internal JSDoc tags
//             on the field's leading comment block.
//   (Phase B+) apiKey?: never
//   (Phase C) field deleted entirely
const fieldDeclMatch = source.match(/(\/\*\*[\s\S]*?\*\/\s*)?apiKey\?\s*:\s*([^;]+);/);
if (fieldDeclMatch) {
  const [, leadingComment = '', typeAnnotation] = fieldDeclMatch;
  const typeStr = typeAnnotation.trim();
  if (typeStr === 'never') {
    // Phase B+: hard-narrowed; no doc requirement
  } else {
    // Phase A: must be deprecated
    if (!/@deprecated/.test(leadingComment)) {
      failures.push(
        'config.ts OpenAiCodexConfig.apiKey field is not annotated `@deprecated`. ' +
        'Phase A migration (spec 12) requires both `@deprecated` and `@internal` ' +
        'JSDoc tags on the field so external callers see warnings while their ' +
        'code keeps compiling. Phase B+ alternative: narrow the type to `apiKey?: never`.',
      );
    }
    if (!/@internal/.test(leadingComment)) {
      failures.push(
        'config.ts OpenAiCodexConfig.apiKey field is not annotated `@internal`. ' +
        'Phase A migration (spec 12) requires both `@deprecated` and `@internal` ' +
        'JSDoc tags on the field.',
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[codex-rule1-drift] DRIFT DETECTED in src/providers/adapters/openai-codex/config.ts:');
  for (const f of failures) {
    console.error('  ✗ ' + f);
  }
  console.error('');
  console.error('See specs/provider-portability/12-openai-path-constraints.md for the full Rule 1 spec.');
  process.exit(1);
}

console.log('[codex-rule1-drift] ✓ config.ts is compliant with spec 12 Rule 1 (Phase A)');
process.exit(0);
