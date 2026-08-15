#!/usr/bin/env node
/**
 * lint-no-direct-llm-http.js — refuses direct LLM-HTTP callsites outside the chokepoint.
 *
 * Implements the "lint rule blocks new raw-HTTP-to-LLM outside the chokepoint"
 * requirement from Phase 1 of
 * docs/specs/token-burn-detection-and-self-heal.md.
 *
 * Only the IntelligenceProvider implementations (and their tests/fixtures)
 * may reference LLM provider URLs directly. Every other call path must go
 * through the IntelligenceProvider interface so the burn-detection system
 * captures attribution.
 *
 * The check is intentionally simple: a grep for known LLM provider host
 * substrings inside `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` files in `src/` and
 * `tests/`. Phase 4 may augment this with an AST-aware variant if grep proves
 * insufficient (similar evolution to lint-no-direct-destructive.js).
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-direct-llm-http.js                # full repo
 *   node scripts/lint-no-direct-llm-http.js --staged       # staged files only
 *   node scripts/lint-no-direct-llm-http.js path1 path2    # specific files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Files that may legitimately reference LLM provider URLs directly.
// Adding entries requires a spec change.
const ALLOWLIST = new Set([
  'src/core/ClaudeCliIntelligenceProvider.ts',
  // The lint rule itself names the URLs in the patterns array.
  'scripts/lint-no-direct-llm-http.js',
  // NOT a URL: OpenAI namespaces its non-standard OIDC claims under a
  // URL-SHAPED KEY, so `https://api.openai.com/auth` appears here as a JSON
  // property name being read out of a locally-stored id_token — never as an
  // endpoint. The module makes no network call of any kind (pure fs read +
  // base64 decode), so there is no inference for burn-detection to attribute.
  // Listed explicitly rather than assembled from fragments: hiding the literal
  // would defeat this lint for every future reader of the file, which is worse
  // than one reviewable exemption.
  'src/providers/adapters/openai-codex/codexSlotIdentity.ts',
  // Provider-portability v1.0.0 (spec/provider-portability): the
  // anthropic-headless adapter implements the IntelligenceProvider
  // contract via legitimate OAuth + Messages-API calls. It IS the
  // chokepoint for that provider — same shape Phase 1 envisioned
  // for AnthropicIntelligenceProvider (which was deleted per Rule 2).
  'src/providers/adapters/anthropic-headless/control/authCredentialInjection.ts',
  'src/providers/adapters/anthropic-headless/observability/usageMeterProvider.ts',
  'src/providers/adapters/anthropic-headless/transport/oneShotCompletion.ts',
  'src/providers/adapters/anthropic-headless/transport/agenticSessionHeadless.ts',
  'src/providers/adapters/anthropic-headless/errors.ts',
  'src/providers/adapters/anthropic-headless/_smoketest.ts',
  'src/providers/adapters/anthropic-headless/capability/fileSystemAccess.ts',
  // Subscription & Auth Standard P1.2: QuotaPoller calls the READ-ONLY
  // /api/oauth/usage telemetry endpoint (the same one the official client's
  // /usage screen calls) to read per-account quota — NOT an LLM inference call,
  // so there is nothing for burn-detection to attribute. Same class as the
  // anthropic-headless usageMeterProvider above.
  'src/core/QuotaPoller.ts',
  // Live credential re-pointing (spec live-credential-repointing-rebalancer.md §2.3/§2.11):
  // the CredentialIdentityOracle calls the READ-ONLY /api/oauth/profile endpoint to read
  // which account a slot's credential belongs to — identity bookkeeping, NOT an LLM
  // inference call, so there is nothing for burn-detection to attribute. Same class as
  // QuotaPoller's /api/oauth/usage call above.
  'src/core/CredentialIdentityOracle.ts',
]);

/**
 * Files that pre-date Phase 1 of the burn-detection spec. They reference LLM
 * provider URLs directly today; future phases of the spec migrate them to the
 * IntelligenceProvider chokepoint. They are grandfathered here so the lint
 * rule blocks NEW violations without breaking the existing tree.
 *
 * Each entry should be removed when the underlying file is migrated. New
 * entries require a spec change.
 */
const GRANDFATHERED = new Set([
  'src/messaging/TelegramAdapter.ts',           // OpenAI voice transcription — burn-detection Phase 5+
  'src/messaging/backends/BaileysBackend.ts',   // OpenAI voice transcription — burn-detection Phase 5+
  'src/monitoring/QuotaCollector.ts',           // Anthropic OAuth (not messages) — left as-is, OAuth ≠ LLM call
  'src/monitoring/StallTriageNurse.ts',         // Direct Anthropic LLM call — burn-detection Phase 2
  'src/commands/server.ts',                     // Voice-provider config registry (string metadata, not call)
  'src/core/CapabilityRegistryGenerator.ts',    // Capability metadata (string platform labels, not call)
  'src/core/CoherenceReviewer.ts',              // Direct Anthropic LLM call — burn-detection Phase 2
]);

// Known LLM provider HTTP endpoints. Grep is the right shape for this — we
// want to catch any string containing these hosts, regardless of how the URL
// is composed.
const FORBIDDEN_PATTERNS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function lineForOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function stripCommentsPreserveLayout(text) {
  let out = '';
  let i = 0;
  let quote = null;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function skipWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function readStringLiteral(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;

  let value = '';
  let i = start + 1;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (escaped) {
      value += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i++;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      return null;
    }
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    value += ch;
    i++;
  }

  return null;
}

function findFoldedStringViolations(text, rel) {
  const stripped = stripCommentsPreserveLayout(text);
  const violations = [];

  for (let i = 0; i < stripped.length; i++) {
    const first = readStringLiteral(stripped, i);
    if (!first) continue;

    let cursor = skipWhitespace(stripped, first.end);
    if (stripped[cursor] !== '+') {
      i = first.end - 1;
      continue;
    }

    const parts = [first.value];
    let end = first.end;
    let literalCount = 1;
    while (stripped[cursor] === '+') {
      const nextStart = skipWhitespace(stripped, cursor + 1);
      const nextString = readStringLiteral(stripped, nextStart);
      if (!nextString) break;
      parts.push(nextString.value);
      literalCount++;
      end = nextString.end;
      cursor = skipWhitespace(stripped, nextString.end);
    }

    if (literalCount > 1) {
      const folded = parts.join('');
      const line = lineForOffset(stripped, i);
      for (const pat of FORBIDDEN_PATTERNS) {
        if (folded.includes(pat)) {
          violations.push({
            file: rel,
            line,
            pattern: pat,
            text: folded.slice(0, 200),
            folded: true,
          });
        }
      }
      i = end - 1;
    }
  }

  return violations;
}

function readGitignoreDirs() {
  // Skip node_modules, dist, .instar/worktrees, etc.
  return new Set(['node_modules', 'dist', 'build', '.instar', '.git', '.next', 'coverage']);
}

function walk(dir, out, skip) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, skip);
    else if (EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
}

function collectFiles(args) {
  if (args.length === 0) {
    const skip = readGitignoreDirs();
    const out = [];
    // Phase 1: lint src/ only. Test files contain LLM URLs as fixtures and
    // assertions; rule scope is production code. Phase 2 may extend.
    for (const sub of ['src']) {
      const p = path.join(ROOT, sub);
      if (fs.existsSync(p)) walk(p, out, skip);
    }
    return out;
  }
  if (args[0] === '--staged') {
    try {
      const stdout = execSync('git diff --cached --name-only --diff-filter=ACMR', {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      return stdout
        .split('\n')
        .filter(Boolean)
        .filter((f) => EXTENSIONS.has(path.extname(f)))
        .map((f) => path.join(ROOT, f));
    } catch {
      return [];
    }
  }
  return args.map((a) => path.resolve(ROOT, a)).filter((f) => fs.existsSync(f));
}

function checkFile(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (ALLOWLIST.has(rel)) return [];
  if (GRANDFATHERED.has(rel)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of FORBIDDEN_PATTERNS) {
      if (line.includes(pat)) {
        violations.push({ file: rel, line: i + 1, pattern: pat, text: line.trim().slice(0, 200) });
      }
    }
  }
  violations.push(...findFoldedStringViolations(text, rel));
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const files = collectFiles(args);
  const all = [];
  for (const f of files) all.push(...checkFile(f));
  if (all.length === 0) {
    process.exit(0);
  }
  console.error('lint-no-direct-llm-http: direct LLM-HTTP references found outside the chokepoint.\n');
  console.error('Every LLM call must go through src/core/AnthropicIntelligenceProvider.ts or');
  console.error('src/core/ClaudeCliIntelligenceProvider.ts so the burn-detection system can');
  console.error('attribute it. See docs/specs/token-burn-detection-and-self-heal.md Phase 1.\n');
  for (const v of all) {
    const reason = v.folded ? `folds to "${v.pattern}"` : `contains "${v.pattern}"`;
    console.error(`  ${v.file}:${v.line} — ${reason}`);
    console.error(`    ${v.text}`);
  }
  process.exit(1);
}

main();
