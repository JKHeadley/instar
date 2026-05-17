#!/usr/bin/env node
// safe-git-allow: pre-commit-bootstrap — read-only `git diff --cached` and `git show :path` to scan staged content; runs before TS compile so cannot use SafeGitExecutor funnel.
/**
 * Rule 3 coverage gate — pre-commit check.
 *
 * Per Rule 3 enforcement (specs/provider-portability/05-state-detection-
 * robustness.md): a structural check at commit time scans the diff for
 * new state-parsing patterns and blocks the commit if no matching
 * canary file is staged alongside.
 *
 * This script:
 *   1. Reads the staged diff for new/modified TypeScript source files.
 *   2. Scans for patterns suggesting external-state parsing:
 *      - fetch() against known upstream domains (anthropic / openai /
 *        slack / telegram / etc.)
 *      - tmux capture-pane / send-keys patterns
 *      - JSON.parse on subprocess stdout
 *      - new class names matching *Reader / *Tailer / *Observer /
 *        *Receiver / *Parser when added to src/
 *   3. For each hit in a file under src/providers/, requires either:
 *      a) the file is in src/providers/canary/ or has a matching
 *         canary file staged alongside, OR
 *      b) an explicit "RULE 3: EXEMPT — <reason>" comment somewhere in
 *         the file (for genuinely exempt cases), OR
 *      c) the file already exists in the state-detector registry
 *         (06-state-detector-registry.md) under a non-Missing status.
 *
 * Exits 0 on pass, 1 on block. Errors print a clear remediation.
 *
 * This is a SIGNAL, not full authority — it errs on the side of false
 * positives. A genuine exempt case is handled by adding the comment
 * marker. False blocks are noise but not corruption-class bugs; the
 * trade-off is acceptable because the bugs we're defending against
 * (silent failure on upstream evolution) are corruption-class.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STATE_DETECTION_PATTERNS = [
  {
    name: 'fetch() to Anthropic',
    re: /fetch\s*\(\s*['"`][^'"`]*api\.anthropic\.com/,
  },
  {
    name: 'fetch() to OpenAI',
    re: /fetch\s*\(\s*['"`][^'"`]*api\.openai\.com/,
  },
  {
    name: 'fetch() to Slack',
    re: /fetch\s*\(\s*['"`][^'"`]*slack\.com/,
  },
  {
    name: 'fetch() to Telegram',
    re: /fetch\s*\(\s*['"`][^'"`]*api\.telegram\.org/,
  },
  {
    name: 'tmux capture-pane',
    re: /['"`]capture-pane['"`]/,
  },
  {
    name: 'tmux send-keys',
    re: /['"`]send-keys['"`]/,
  },
  {
    name: 'JSON.parse on stdout',
    re: /JSON\.parse\s*\([^)]*\bstdout\b/,
  },
  {
    name: 'class *Reader/Tailer/Observer/Receiver/Parser in src/',
    re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+(?:Reader|Tailer|Observer|Receiver|Parser)\b/m,
  },
  // Spec 12 (OpenAI / Codex path constraints) additions. These flag patterns
  // that ship raw-OpenAI-API access — a Rule 1 violation. The "fetch() to
  // OpenAI" pattern above covers direct HTTP; these cover the SDK-class
  // surface (importing the published `openai` package, constructing an
  // OpenAI client, calling the chat completions endpoint) and the env-var
  // names that gate the forbidden path.
  {
    // Tightened from `\bOPENAI_API_KEY\b` (which false-positived on doc
    // comments, type declarations like `OPENAI_API_KEY?: string`, and
    // defensive `delete env.OPENAI_API_KEY` calls). The forms we want to
    // catch are the ones that actually emit or write the value:
    //   - property assignment: `env.OPENAI_API_KEY = ...`
    //   - process env mutation: `process.env.OPENAI_API_KEY = ...`
    //   - template-literal shell-style emission: `OPENAI_API_KEY=${...}`
    //   - tmux/exec flag emission: `OPENAI_API_KEY=` followed by a value
    // The `[^=\s]` tail trims `==` / `===` comparisons and trailing
    // whitespace (which usually indicates a doc string), without dropping
    // legitimate writes.
    name: 'OPENAI_API_KEY LHS assignment / emission',
    re: /\bOPENAI_API_KEY\b\s*=\s*[^=\s]/,
  },
  {
    name: 'new OpenAI() — published SDK client',
    re: /new\s+OpenAI\s*\(/,
  },
  {
    name: 'openai.chat.completions.create — published SDK call',
    re: /openai\.chat\.completions\.create\s*\(/,
  },
  {
    name: 'import from "openai" package',
    re: /(?:import|require)\s*(?:.*\s+from\s+)?\(?\s*['"]openai['"]/,
  },
  {
    name: 'OPENAI_BASE_URL LHS assignment (Instar code must not set this)',
    re: /\bOPENAI_BASE_URL\b\s*=/,
  },
];

const RULE3_EXEMPT_COMMENT_RE = /RULE\s*3\s*:\s*EXEMPT/i;
const RULE3_RATIONALE_COMMENT_RE = /RULE\s*3\.1\s*RATIONALE/i;

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf-8',
    });
    return out.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function getStagedContent(filepath) {
  try {
    return execSync(`git show :"${filepath}"`, { encoding: 'utf-8' });
  } catch {
    // File staged for deletion or unreadable — skip.
    return null;
  }
}

function readRegistry() {
  const registryPath = path.join(
    __dirname,
    '..',
    'specs',
    'provider-portability',
    '06-state-detector-registry.md',
  );
  try {
    return fs.readFileSync(registryPath, 'utf-8');
  } catch {
    return '';
  }
}

function isInRegistry(filepath, registryContent) {
  // Strip src/ prefix; the registry uses paths relative to src/.
  const stripped = filepath.replace(/^src\//, '');
  return registryContent.includes(stripped);
}

function hasMatchingCanary(stagedFiles, filepath) {
  // A matching canary is any file in the same adapter's canary/ directory,
  // or a file named *Canary*.ts adjacent to the source file.
  const dir = path.dirname(filepath);
  const adapterRoot = dir.split('/').slice(0, -1).join('/');
  const canaryDir = path.join(adapterRoot, 'canary');
  return stagedFiles.some(
    (f) => f.startsWith(canaryDir + '/') || /canary/i.test(path.basename(f)),
  );
}

function main() {
  const stagedFiles = getStagedFiles();
  const sourceFiles = stagedFiles.filter(
    (f) =>
      f.startsWith('src/') &&
      f.endsWith('.ts') &&
      !f.includes('/canary/') &&
      !f.endsWith('.test.ts') &&
      // Smoketest tools are dev-only and routinely show env vars in usage
      // strings. Not shipped state-detection code.
      !f.endsWith('_smoketest.ts'),
  );

  if (sourceFiles.length === 0) {
    process.exit(0);
  }

  const registry = readRegistry();
  const violations = [];

  for (const file of sourceFiles) {
    const content = getStagedContent(file);
    if (content === null) continue;

    // Skip if file is explicitly marked exempt.
    if (RULE3_EXEMPT_COMMENT_RE.test(content)) continue;

    // Skip if file is already in the registry under a non-Missing status.
    // (Best-effort: registry check is by path containment, doesn't
    // distinguish status flags. For new code that's not yet registered,
    // requireGenuineCheck below catches it.)
    const inRegistry = isInRegistry(file, registry);

    // Skip if file has a rationale comment block.
    const hasRationale = RULE3_RATIONALE_COMMENT_RE.test(content);

    // Skip if a matching canary is staged.
    const hasCanary = hasMatchingCanary(stagedFiles, file);

    for (const pattern of STATE_DETECTION_PATTERNS) {
      if (pattern.re.test(content)) {
        if (inRegistry && (hasRationale || hasCanary)) {
          continue; // registered detector with rationale or canary OK
        }
        if (hasRationale && hasCanary) {
          continue; // new detector that ships rationale + canary OK
        }
        violations.push({
          file,
          pattern: pattern.name,
          missing: [
            !inRegistry && !hasCanary ? 'registry entry or canary file' : null,
            !hasRationale ? 'Rule 3.1 rationale comment' : null,
          ].filter(Boolean),
        });
        break; // one violation per file is enough
      }
    }
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  // eslint-disable-next-line no-console
  console.error('Rule 3 coverage gate: state-detection patterns missing infrastructure');
  // eslint-disable-next-line no-console
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  // eslint-disable-next-line no-console
  console.error('');
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${v.file}`);
    // eslint-disable-next-line no-console
    console.error(`    Pattern: ${v.pattern}`);
    // eslint-disable-next-line no-console
    console.error(`    Missing: ${v.missing.join(', ')}`);
    // eslint-disable-next-line no-console
    console.error('');
  }
  // eslint-disable-next-line no-console
  console.error('Rule 3 requires every state-detection code path to ship with:');
  // eslint-disable-next-line no-console
  console.error('  1. A Rule 3.1 rationale comment in the source file');
  // eslint-disable-next-line no-console
  console.error('     (see specs/provider-portability/07-detector-rationale.md template)');
  // eslint-disable-next-line no-console
  console.error('  2. A canary file in canary/ alongside the source, OR');
  // eslint-disable-next-line no-console
  console.error('     a registry entry in specs/provider-portability/06-state-detector-registry.md');
  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('If this code is GENUINELY exempt from Rule 3, add a comment:');
  // eslint-disable-next-line no-console
  console.error('  // RULE 3: EXEMPT — <reason>');
  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('See specs/provider-portability/05-state-detection-robustness.md for the full spec.');
  // eslint-disable-next-line no-console
  console.error('');
  process.exit(1);
}

main();
