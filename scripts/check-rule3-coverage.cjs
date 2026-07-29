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

/**
 * The incoming ref, if a merge is in progress. `MERGE_HEAD` exists only between
 * `git merge` starting and the merge commit being written — exactly the window
 * this hook runs in.
 */
function mergeHeadIfMerging() {
  try {
    const out = execSync('git rev-parse -q --verify MERGE_HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null; // not a merge — `rev-parse -q --verify` exits non-zero
  }
}

function getStagedFiles() {
  // During a MERGE the index holds every file that differs between the branch
  // base and the incoming ref — i.e. effectively all of the incoming branch.
  // Judging that as the committer's work makes anyone merging `main` into an
  // older branch the author of all of `main`, so they are refused for
  // pre-existing violations that are absent from their own diff and that they
  // did not write. That refusal names a file they cannot see, so the natural
  // responses are to edit someone else's code or reach for --no-verify.
  //
  // A committer's real contribution to a merge is what differs from the
  // INCOMING ref: a file taken verbatim from MERGE_HEAD was not authored here.
  // A conflict resolution DOES differ from MERGE_HEAD, so genuinely authored
  // content is still evaluated — see the merge-semantics tests, which assert
  // both directions.
  const mergeHead = mergeHeadIfMerging();
  if (mergeHead) {
    try {
      const out = execSync(
        `git diff --cached --name-only --diff-filter=ACMR ${mergeHead}`,
        { encoding: 'utf-8' },
      );
      return out.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      // Fall through to the full staged list — the STRICTER reading, so a
      // failure here can only over-report, never silently let code past.
    }
  }
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
  // The registry's Location column is SECTION-relative, not uniformly relative
  // to src/. Most sections write paths relative to src/, but the provider
  // substrate section ("Provider substrate (`src/providers/`)") writes them
  // relative to src/providers/ — 21 of its 23 rows, measured on main.
  //
  // Stripping only `src/` therefore looked for `providers/adapters/X.ts` while
  // the row said `adapters/X.ts`, so no provider file could ever match. A file
  // listed in three registry rows was still refused for a "missing registry
  // entry", which told the author to add a row that already existed.
  if (registryContent.includes(filepath.replace(/^src\//, ''))) return true;
  // Only widen for genuine provider paths, so no other file gains a match it
  // would not otherwise have had.
  if (filepath.startsWith('src/providers/')) {
    return registryContent.includes(filepath.replace(/^src\/providers\//, ''));
  }
  return false;
}

function hasMatchingCanary(stagedFiles, filepath) {
  // A matching canary is any file in the same adapter's canary/ directory,
  // or a file named *Canary*.ts ADJACENT to the source file.
  //
  // "Adjacent" used to be unimplemented: the second clause tested
  // `/canary/i.test(path.basename(f))` against every staged file without ever
  // referencing `filepath`. That made it a property of the COMMIT, not a
  // relationship — stage one canary-named file anywhere and every other file in
  // the change was credited with having a canary. src/ carries 11 such files, so
  // any broad commit touching one satisfied the canary half of Rule 3 wholesale.
  //
  // It failed in the QUIET direction (weakening the gate rather than blocking
  // wrongly), which is why nothing ever complained about it.
  // TWO canary/ locations, because sources sit at two depths. A source one
  // level below the adapter root (adapters/X/observability/foo.ts) has its
  // canary at adapters/X/canary/; a source AT the adapter root
  // (adapters/X/foo.ts) has it at adapters/X/canary/ too — but that is
  // `<dir>/canary`, not `<parent>/canary`. The original computed only the
  // parent form, so the directory clause silently missed the second layout and
  // the global fallback above was covering for it. Removing the fallback
  // without fixing this would have turned a too-weak check into a wrong one.
  const dir = path.dirname(filepath);
  const adapterRoot = dir.split('/').slice(0, -1).join('/');
  const canaryDirs = [path.join(dir, 'canary'), path.join(adapterRoot, 'canary')];
  return stagedFiles.some(
    (f) =>
      canaryDirs.some((cd) => f.startsWith(cd + '/')) ||
      (path.dirname(f) === dir && /canary/i.test(path.basename(f))),
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
