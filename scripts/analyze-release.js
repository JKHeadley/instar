#!/usr/bin/env node
// safe-git-allow: release analyzer runs before TS source is compiled; read-only git only.
/**
 * Release Change Analyzer
 *
 * Analyzes the git diff between the last release tag and HEAD to produce
 * an intelligent assessment of what changed and what the version bump should be.
 *
 * This script does THREE things:
 *   1. CLASSIFIES every change by type (feature, fix, refactor, breaking, etc.)
 *   2. DETERMINES the appropriate version bump based on actual code changes
 *   3. VALIDATES the upgrade guide covers all significant changes
 *
 * Exit codes:
 *   0 — Analysis passed, guide adequately covers changes
 *   1 — Guide is missing coverage of significant changes, or bump type is wrong
 *
 * Output:
 *   JSON report to stdout with change classification, recommended bump, and coverage gaps.
 *   Human-readable summary to stderr.
 *
 * Usage:
 *   node scripts/analyze-release.js                    # Full analysis + validation
 *   node scripts/analyze-release.js --json             # JSON report only
 *   node scripts/analyze-release.js --recommend-only   # Just recommend bump type
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const RECOMMEND_ONLY = args.includes('--recommend-only');
// --draft-guide writes/merges upgrades/NEXT.md from the computed change-list
// (Layer A of the release-readiness-visibility spec). Drafted content carries
// `auto-draft-unreviewed` markers that BOTH publish gates reject until a human
// reviews each section — so auto-fill can never ship un-reviewed notes.
const DRAFT_GUIDE = args.includes('--draft-guide');

// --ref=<rev> selects the tip the analysis runs against (default HEAD).
// Layer B of the release-readiness-visibility spec passes --ref=FETCH_HEAD so the
// readiness check evaluates against canonical main, not the local checkout. The
// default preserves the prepublish chain's behavior exactly (it never passes --ref).
const REF = (() => {
  const flag = args.find((a) => a === '--ref' || a.startsWith('--ref='));
  if (!flag) return 'HEAD';
  if (flag === '--ref') {
    const idx = args.indexOf(flag);
    return args[idx + 1] || 'HEAD';
  }
  return flag.slice('--ref='.length) || 'HEAD';
})();

function log(msg) {
  if (!JSON_ONLY) process.stderr.write(msg + '\n');
}

// ── Git Helpers ──────────────────────────────────────────────────────

function gitRead(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function getLastReleaseTag() {
  try {
    return gitRead(['describe', '--tags', '--abbrev=0', REF]).trim();
  } catch {
    // No tags at all — diff against the initial commit reachable from REF
    return gitRead(['rev-list', '--max-parents=0', REF]).trim();
  }
}

function getCommitsSinceTag(tag) {
  try {
    const raw = gitRead(['log', `${tag}..${REF}`, '--oneline', '--no-merges']);
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ...rest] = line.split(' ');
      return { hash, message: rest.join(' ') };
    });
  } catch {
    return [];
  }
}

function getDiffStat(tag) {
  try {
    return gitRead(['diff', `${tag}..${REF}`, '--stat']).trim();
  } catch {
    return '';
  }
}

function getChangedFiles(tag) {
  try {
    const raw = gitRead(['diff', `${tag}..${REF}`, '--name-status']);
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.charAt(0), file: pathParts.join('\t') };
    });
  } catch {
    return [];
  }
}

function getFileDiff(tag, file) {
  try {
    return gitRead(['diff', `${tag}..${REF}`, '--', file]);
  } catch {
    return '';
  }
}

// ── Change Detection ─────────────────────────────────────────────────

/**
 * Analyze route changes — new/modified/removed API endpoints.
 */
function analyzeRouteChanges(tag, changedFiles) {
  const routeFiles = changedFiles.filter(f =>
    f.file.startsWith('src/server/') && f.file.endsWith('.ts')
  );

  const changes = {
    newEndpoints: [],
    removedEndpoints: [],
    modifiedEndpoints: [],
  };

  for (const { file } of routeFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    for (const line of lines) {
      // Match router.get/post/put/delete/patch patterns
      const endpointMatch = line.match(/^[+-]\s*router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (endpointMatch) {
        const [, method, path] = endpointMatch;
        const endpoint = `${method.toUpperCase()} ${path}`;

        if (line.startsWith('+')) {
          changes.newEndpoints.push({ endpoint, file });
        } else if (line.startsWith('-')) {
          changes.removedEndpoints.push({ endpoint, file });
        }
      }
    }
  }

  // Endpoints that appear in both added and removed are modifications
  const addedPaths = new Set(changes.newEndpoints.map(e => e.endpoint));
  const removedPaths = new Set(changes.removedEndpoints.map(e => e.endpoint));

  for (const endpoint of addedPaths) {
    if (removedPaths.has(endpoint)) {
      changes.modifiedEndpoints.push({ endpoint });
      changes.newEndpoints = changes.newEndpoints.filter(e => e.endpoint !== endpoint);
      changes.removedEndpoints = changes.removedEndpoints.filter(e => e.endpoint !== endpoint);
    }
  }

  return changes;
}

/**
 * Analyze CLI command changes.
 */
function analyzeCLIChanges(tag, changedFiles) {
  const cliFiles = changedFiles.filter(f =>
    f.file === 'src/cli.ts' || f.file.startsWith('src/commands/')
  );

  const changes = {
    newCommands: [],
    removedCommands: [],
    modifiedCommands: [],
  };

  for (const { file } of cliFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    for (const line of lines) {
      // Match .command('name') patterns
      const cmdMatch = line.match(/^[+-]\s*\.command\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (cmdMatch) {
        const command = cmdMatch[1];
        if (line.startsWith('+')) {
          changes.newCommands.push({ command, file });
        } else if (line.startsWith('-')) {
          changes.removedCommands.push({ command, file });
        }
      }
    }
  }

  return changes;
}

/**
 * Analyze config schema changes.
 */
function analyzeConfigChanges(tag, changedFiles) {
  const configFiles = changedFiles.filter(f =>
    f.file === 'src/core/types.ts' || f.file === 'src/core/Config.ts'
  );

  const changes = {
    newConfigFields: [],
    removedConfigFields: [],
    changedInterfaces: [],
  };

  for (const { file } of configFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    let inInterface = false;
    let currentInterface = '';

    for (const line of lines) {
      // Track interface context
      const ifaceMatch = line.match(/^[+-]?\s*export\s+interface\s+(\w+)/);
      if (ifaceMatch) {
        currentInterface = ifaceMatch[1];
        inInterface = true;
        if (line.startsWith('+')) {
          changes.changedInterfaces.push(currentInterface);
        }
      }

      // Track field additions/removals within interfaces
      if (inInterface) {
        const fieldMatch = line.match(/^([+-])\s+(\w+)\??\s*:/);
        if (fieldMatch) {
          const [, sign, field] = fieldMatch;
          if (sign === '+') {
            changes.newConfigFields.push({ field, interface: currentInterface });
          } else {
            changes.removedConfigFields.push({ field, interface: currentInterface });
          }
        }
      }

      if (line.match(/^[+-]?\s*\}/)) {
        inInterface = false;
      }
    }
  }

  return changes;
}

/**
 * Analyze export changes in index.ts.
 */
function analyzeExportChanges(tag, changedFiles) {
  const indexChanged = changedFiles.some(f => f.file === 'src/index.ts');
  if (!indexChanged) return { newExports: [], removedExports: [] };

  const diff = getFileDiff(tag, 'src/index.ts');
  const lines = diff.split('\n');
  const changes = { newExports: [], removedExports: [] };

  for (const line of lines) {
    const exportMatch = line.match(/^([+-])\s*export\s+(?:type\s+)?{?\s*(\w+)/);
    if (exportMatch) {
      const [, sign, name] = exportMatch;
      if (sign === '+') changes.newExports.push(name);
      else changes.removedExports.push(name);
    }
  }

  return changes;
}

/**
 * Analyze file-level changes for high-level classification.
 */
function analyzeFileChanges(changedFiles) {
  const summary = {
    newFiles: changedFiles.filter(f => f.status === 'A'),
    deletedFiles: changedFiles.filter(f => f.status === 'D'),
    modifiedFiles: changedFiles.filter(f => f.status === 'M'),
    renamedFiles: changedFiles.filter(f => f.status === 'R'),
    srcChanges: changedFiles.filter(f => f.file.startsWith('src/')),
    testChanges: changedFiles.filter(f => f.file.startsWith('tests/')),
    docChanges: changedFiles.filter(f => f.file.endsWith('.md') || f.file.startsWith('docs/')),
    configChanges: changedFiles.filter(f =>
      f.file.endsWith('.json') || f.file.endsWith('.yml') || f.file.endsWith('.yaml')
    ),
    hookChanges: changedFiles.filter(f => f.file.includes('hooks/')),
    templateChanges: changedFiles.filter(f => f.file.includes('templates/')),
    dashboardChanges: changedFiles.filter(f => f.file.startsWith('dashboard/')),
  };

  return summary;
}

/**
 * Classify commits by conventional commit type.
 */
function classifyCommits(commits) {
  const classified = {
    features: [],
    fixes: [],
    refactors: [],
    docs: [],
    tests: [],
    chores: [],
    breaking: [],
    other: [],
  };

  for (const commit of commits) {
    const msg = commit.message.toLowerCase();

    if (msg.startsWith('feat') || msg.includes('add ') || msg.includes('new ')) {
      classified.features.push(commit);
    } else if (msg.startsWith('fix') || msg.includes('fix ') || msg.includes('patch')) {
      classified.fixes.push(commit);
    } else if (msg.startsWith('refactor') || msg.includes('refactor')) {
      classified.refactors.push(commit);
    } else if (msg.startsWith('docs') || msg.startsWith('doc:')) {
      classified.docs.push(commit);
    } else if (msg.startsWith('test') || msg.includes('test')) {
      classified.tests.push(commit);
    } else if (msg.startsWith('chore') || msg.startsWith('bump') || msg.includes('[skip ci]')) {
      classified.chores.push(commit);
    } else {
      classified.other.push(commit);
    }

    // Breaking change markers
    if (msg.includes('breaking') || msg.includes('!:') || msg.includes('removed ')) {
      classified.breaking.push(commit);
    }
  }

  return classified;
}

// ── Bump Type Recommendation ─────────────────────────────────────────

function recommendBumpType(analysis) {
  const { routes, cli, config, exports, files, commits } = analysis;

  // MAJOR indicators
  const majorSignals = [];

  if (routes.removedEndpoints.length > 0) {
    majorSignals.push(`${routes.removedEndpoints.length} API endpoint(s) removed`);
  }
  if (exports.removedExports.length > 0) {
    majorSignals.push(`${exports.removedExports.length} export(s) removed from public API`);
  }
  if (config.removedConfigFields.length > 0) {
    majorSignals.push(`${config.removedConfigFields.length} config field(s) removed`);
  }
  if (commits.breaking.length > 0) {
    majorSignals.push(`${commits.breaking.length} commit(s) marked as breaking`);
  }

  // MINOR indicators
  const minorSignals = [];

  if (routes.newEndpoints.length > 0) {
    minorSignals.push(`${routes.newEndpoints.length} new API endpoint(s)`);
  }
  if (cli.newCommands.length > 0) {
    minorSignals.push(`${cli.newCommands.length} new CLI command(s)`);
  }
  if (exports.newExports.length > 0) {
    minorSignals.push(`${exports.newExports.length} new export(s) added to public API`);
  }
  if (commits.features.length > 0) {
    minorSignals.push(`${commits.features.length} feature commit(s)`);
  }
  if (files.newFiles.filter(f => f.file.startsWith('src/')).length >= 3) {
    minorSignals.push(`${files.newFiles.filter(f => f.file.startsWith('src/')).length} new source files`);
  }

  // PATCH indicators (default)
  const patchSignals = [];

  if (commits.fixes.length > 0) {
    patchSignals.push(`${commits.fixes.length} fix commit(s)`);
  }
  if (commits.refactors.length > 0) {
    patchSignals.push(`${commits.refactors.length} refactor commit(s)`);
  }
  if (commits.tests.length > 0) {
    patchSignals.push(`${commits.tests.length} test commit(s)`);
  }
  if (commits.docs.length > 0) {
    patchSignals.push(`${commits.docs.length} doc commit(s)`);
  }

  // Decision
  let recommended;
  if (majorSignals.length > 0) {
    recommended = 'major';
  } else if (minorSignals.length > 0) {
    recommended = 'minor';
  } else {
    recommended = 'patch';
  }

  return {
    recommended,
    majorSignals,
    minorSignals,
    patchSignals,
  };
}

// ── Upgrade Guide Coverage Validation ────────────────────────────────

function validateGuideCoverage(analysis, guideContent) {
  const gaps = [];

  // Check that new endpoints are mentioned
  for (const { endpoint } of analysis.routes.newEndpoints) {
    const pathPart = endpoint.split(' ')[1]; // e.g., '/evolution/proposals'
    if (!guideContent.includes(pathPart)) {
      gaps.push({
        type: 'missing-endpoint',
        severity: 'high',
        detail: `New endpoint ${endpoint} not mentioned in upgrade guide`,
      });
    }
  }

  // Check that removed endpoints are mentioned (breaking!)
  for (const { endpoint } of analysis.routes.removedEndpoints) {
    const pathPart = endpoint.split(' ')[1];
    if (!guideContent.includes(pathPart)) {
      gaps.push({
        type: 'missing-breaking-change',
        severity: 'critical',
        detail: `Removed endpoint ${endpoint} not mentioned in upgrade guide — agents using this will break`,
      });
    }
  }

  // Check that new CLI commands are mentioned
  for (const { command } of analysis.cli.newCommands) {
    if (!guideContent.includes(command)) {
      gaps.push({
        type: 'missing-command',
        severity: 'medium',
        detail: `New CLI command '${command}' not mentioned in upgrade guide`,
      });
    }
  }

  // Check that removed exports are mentioned
  for (const name of analysis.exports.removedExports) {
    if (!guideContent.includes(name)) {
      gaps.push({
        type: 'missing-removed-export',
        severity: 'high',
        detail: `Removed export '${name}' not mentioned — consumers may break`,
      });
    }
  }

  // Check that new config fields are mentioned
  for (const { field } of analysis.config.newConfigFields) {
    if (!guideContent.includes(field)) {
      gaps.push({
        type: 'missing-config-field',
        severity: 'low',
        detail: `New config field '${field}' not mentioned in upgrade guide`,
      });
    }
  }

  // Check that feature commits are represented
  for (const commit of analysis.commits.features) {
    // Extract the key noun from the commit message
    const keywords = commit.message
      .replace(/^feat[:(]?\s*/i, '')
      .replace(/[()]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 3);

    const mentioned = keywords.some(kw =>
      guideContent.toLowerCase().includes(kw.toLowerCase())
    );

    if (!mentioned && keywords.length > 0) {
      gaps.push({
        type: 'missing-feature',
        severity: 'medium',
        detail: `Feature commit "${commit.message}" may not be covered in upgrade guide`,
      });
    }
  }

  return gaps;
}

// ── Change Descriptions (for upgrade guide generation) ───────────────

function generateChangeDescriptions(analysis) {
  const descriptions = [];

  // New endpoints
  for (const { endpoint, file } of analysis.routes.newEndpoints) {
    descriptions.push({
      type: 'feature',
      summary: `New API endpoint: ${endpoint}`,
      detail: `Added in ${file}`,
      agentImpact: 'New capability available via HTTP API',
      userImpact: 'New feature accessible through the agent',
    });
  }

  // Removed endpoints
  for (const { endpoint, file } of analysis.routes.removedEndpoints) {
    descriptions.push({
      type: 'breaking',
      summary: `Removed API endpoint: ${endpoint}`,
      detail: `Removed from ${file}`,
      agentImpact: 'Agents using this endpoint will get 404 errors',
      userImpact: 'Feature no longer available',
    });
  }

  // New CLI commands
  for (const { command } of analysis.cli.newCommands) {
    descriptions.push({
      type: 'feature',
      summary: `New CLI command: instar ${command}`,
      detail: 'New command available from the terminal',
      agentImpact: 'New capability available via CLI',
      userImpact: 'Can be used directly or by the agent',
    });
  }

  // New config fields
  for (const { field, interface: iface } of analysis.config.newConfigFields) {
    descriptions.push({
      type: 'enhancement',
      summary: `New config option: ${field} (${iface})`,
      detail: 'New configuration setting available',
      agentImpact: 'Agent can use this setting to customize behavior',
      userImpact: 'More customization options',
    });
  }

  // Feature commits not captured by structural analysis
  for (const commit of analysis.commits.features) {
    const alreadyCovered = descriptions.some(d =>
      commit.message.toLowerCase().includes(d.summary.toLowerCase().split(':')[1]?.trim() || '___')
    );
    if (!alreadyCovered) {
      descriptions.push({
        type: 'feature',
        summary: commit.message,
        detail: `Commit: ${commit.hash}`,
        agentImpact: 'Review the commit for specifics',
        userImpact: 'Review the commit for user-facing changes',
      });
    }
  }

  // Fix commits
  for (const commit of analysis.commits.fixes) {
    descriptions.push({
      type: 'fix',
      summary: commit.message,
      detail: `Commit: ${commit.hash}`,
      agentImpact: 'Bug fix — previous behavior was incorrect',
      userImpact: 'Improved reliability',
    });
  }

  return descriptions;
}

// ── Auto-draft (Layer A of release-readiness-visibility spec) ────────
//
// Turns the computed change-list into a NEXT.md draft. Every drafted item
// carries an `auto-draft-unreviewed` marker. The publish gates
// (check-upgrade-guide.js validator + publish.yml skip predicate) refuse to
// ship a guide that still has those markers, so auto-fill removes the "blank
// guide" root cause WITHOUT defeating the human-review purpose of the gate.

const UNREVIEWED_BLOCK_MARKER = '<!-- auto-draft-unreviewed-block -->';
const UNCOVERED_BEGIN = '<!-- BEGIN auto-draft-uncovered (unreviewed) -->';
const UNCOVERED_END = '<!-- END auto-draft-uncovered (unreviewed) -->';

/**
 * Neutralize commit-message-sourced text before it lands in a published guide:
 *   - strip HTML comments (prevents forging `<!-- bump: -->` / unreviewed markers)
 *   - collapse whitespace, cap length
 *   - escape leading markdown control chars so an item can't break section bounds
 */
function sanitizeDraftText(s) {
  let t = String(s ?? '')
    .replace(/<!--[\s\S]*?-->/g, '') // strip HTML comments
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 200) t = t.slice(0, 197).trimEnd() + '…';
  // Escape leading control sequences (heading / hr) so a crafted message can't
  // inject a new section boundary.
  t = t.replace(/^(#{1,6}\s)/, '\\$1').replace(/^(-{3,})/, '\\$1');
  return t;
}

const FALLBACK_USER_IMPACTS = new Set([
  'Review the commit for user-facing changes',
  'Review the commit for specifics',
]);

function unreviewed(slug) {
  return `<!-- auto-draft-unreviewed: ${slug} -->`;
}

/** Does the existing guide already mention this change description? */
function descriptionMentioned(desc, content) {
  const lc = content.toLowerCase();
  // Endpoint: the path token (e.g. "/release-readiness").
  const ep = /:\s*[A-Z]+\s+(\/\S+)/.exec(desc.summary);
  if (ep) return lc.includes(ep[1].toLowerCase());
  // CLI command: "instar <cmd>".
  const cmd = /instar\s+([a-z][\w:-]*)/i.exec(desc.summary);
  if (cmd) return lc.includes(cmd[1].toLowerCase());
  // Config field: "New config option: <field>".
  const cfg = /config option:\s*(\w+)/i.exec(desc.summary);
  if (cfg) return lc.includes(cfg[1].toLowerCase());
  // Otherwise (commit-derived): any >4-char keyword from the summary.
  const kws = desc.summary.replace(/^(feat|fix)[:(]?\s*/i, '').split(/\s+/).filter((w) => w.length > 4).slice(0, 4);
  return kws.length > 0 && kws.some((k) => lc.includes(k.toLowerCase()));
}

/** One "## What Changed" bullet for a description. */
function changedBullet(desc) {
  return `- **${desc.type}**: ${sanitizeDraftText(desc.summary)} — ${sanitizeDraftText(desc.detail)}`;
}

/** Build the three required sections' bodies from the change-list. */
function buildSectionBodies(changeDescriptions, hasFix) {
  const whatChanged = changeDescriptions.length
    ? changeDescriptions.map(changedBullet).join('\n')
    : '- (no structurally-detected changes; describe the release manually)';

  // "What to Tell Your User" must stay plain — no backticks/camelCase/code.
  // Use the generic userImpact lines (already plain) and a HUMAN-REQUIRED note
  // for any commit whose impact the analyzer couldn't infer.
  const userLines = [];
  const seen = new Set();
  for (const d of changeDescriptions) {
    const impact = FALLBACK_USER_IMPACTS.has(d.userImpact)
      ? 'HUMAN-REQUIRED: describe what this means for the user'
      : d.userImpact;
    const line = `- ${sanitizeDraftText(impact)}`;
    if (!seen.has(line)) { seen.add(line); userLines.push(line); }
  }
  const tellUser = userLines.length ? userLines.join('\n') : '- HUMAN-REQUIRED: summarize the user-facing impact';

  const capRows = changeDescriptions
    .filter((d) => d.type === 'feature' || d.type === 'enhancement')
    .map((d) => `| ${sanitizeDraftText(d.summary)} | ${sanitizeDraftText(d.agentImpact)} |`)
    .join('\n') || '| (none) | — |';

  let out =
`## What Changed

${unreviewed('what-changed')}
${whatChanged}

## What to Tell Your User

${unreviewed('tell-user')}
${tellUser}

## Summary of New Capabilities

${unreviewed('capabilities')}
| Capability | How to Use |
|-----------|-----------|
${capRows}
`;

  if (hasFix) {
    out +=
`
## Evidence

${unreviewed('evidence')}
HUMAN-REQUIRED: reproduction + observed before/after, or "Not reproducible in dev — [concrete reason]". Unit tests passing is not evidence.
`;
  }
  return out;
}

/**
 * Build the silent-by-default `user_announcement` front-matter block
 * (MATURE-UPDATE-ANNOUNCEMENTS spec D3). One entry per feature/enhancement,
 * every entry defaulting to `audience: agent-only` + `maturity: experimental`
 * — so NOTHING reaches the user until a human deliberately flips an entry to
 * `audience: user`. An un-reviewed block is therefore SAFE (it announces
 * nothing). Parsed at notify-time by src/core/upgradeAnnouncement.ts; the
 * coherence check over edited entries is the canonical TS helper
 * `announcementCoherenceWarnings`.
 */
function buildAnnouncementFrontmatter(changeDescriptions) {
  const candidates = changeDescriptions.filter(
    (d) => d.type === 'feature' || d.type === 'enhancement'
  );
  const yamlStr = (s) => `"${String(s ?? '').replace(/"/g, '\\"')}"`;
  const entries = candidates.length
    ? candidates
        .map(
          (d) =>
            `  - audience: agent-only   # flip to "user" to announce to the user
    maturity: experimental # experimental | preview | stable
    headline: ${yamlStr(sanitizeDraftText(d.summary))}
    body: ${yamlStr('HUMAN-REQUIRED: one or two plain sentences for the user, matching the maturity above')}`
        )
        .join('\n')
    : '  # (no feature/enhancement changes detected — add an entry only if a change is user-facing)';

  return `---
# user_announcement — SILENT BY DEFAULT (mature-update-announcements spec).
# Every entry below defaults to agent-only, so the user hears NOTHING about this
# release until you deliberately set an entry's audience to "user". Then set its
# maturity honestly: experimental (early, not for general use), preview (try it,
# still rough), or stable (finished, use it now).
user_announcement:
${entries}
---
`;
}

/** Full NEXT.md draft (used when the guide is absent or a pristine template). */
function buildFullDraft(changeDescriptions, recommended, hasFix) {
  return `${buildAnnouncementFrontmatter(changeDescriptions)}# Upgrade Guide — vNEXT

<!-- bump: ${recommended} -->
${UNREVIEWED_BLOCK_MARKER}
<!-- Auto-drafted from the classified commit range. Every section below carries an
     auto-draft-unreviewed marker. A human reviews each section and replaces its
     marker with a reviewed-by receipt before this guide can publish.
     See docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.1.1. -->

${buildSectionBodies(changeDescriptions, hasFix)}`;
}

/** The uncovered-delta block appended to a guide that already has human content. */
function buildUncoveredBlock(changeDescriptions, existingContent) {
  const uncovered = changeDescriptions.filter((d) => !descriptionMentioned(d, existingContent));
  if (uncovered.length === 0) return '';
  const items = uncovered.map((d) => `- ${unreviewed(slugifyDesc(d))} **${d.type}**: ${sanitizeDraftText(d.summary)}`).join('\n');
  return `${UNCOVERED_BEGIN}
<!-- These changes were detected in the commit range but not yet mentioned above.
     Fold them into the sections above (or describe why they need no note), then
     remove each marker with a reviewed-by receipt. -->
${items}
${UNCOVERED_END}`;
}

function slugifyDesc(d) {
  return (d.summary || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

const PRISTINE_TEMPLATE = (c) => c.includes('[Feature name]') && c.includes('[Capability]');

/**
 * Write or merge upgrades/NEXT.md. Race-guarded against publish finalize.
 * Returns a short status string for logging.
 */
function writeOrMergeGuide(changeDescriptions, recommended, hasFix) {
  const upgradesDir = path.join(ROOT, 'upgrades');
  const nextPath = path.join(upgradesDir, 'NEXT.md');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const versionGuide = path.join(upgradesDir, `${pkg.version}.md`);

  fs.mkdirSync(upgradesDir, { recursive: true });

  // Race guard against publish-finalize: refuse to draft once a finalize has
  // produced upgrades/{version}.md. Per RELEASE-READINESS-VISIBILITY-SPEC §4.1.3
  // this version-file check IS the cross-host guarantee (finalize renames
  // NEXT.md → {version}.md in CI on a separate checkout; git's ref-update
  // atomicity covers the merge). The intra-host O_EXCL advisory lock the spec
  // also describes is intentionally omitted here: releasing it requires a
  // destructive fs.unlink (forbidden by lint-no-direct-destructive in this
  // dependency-free, test-copyable script), and the draft job is single-runner
  // per the multi-machine lease, so concurrent local drafters don't occur.
  if (fs.existsSync(versionGuide)) {
    return `skipped: upgrades/${pkg.version}.md already finalized — not drafting`;
  }

  const existing = fs.existsSync(nextPath) ? fs.readFileSync(nextPath, 'utf-8') : '';

  if (!existing.trim() || PRISTINE_TEMPLATE(existing)) {
    fs.writeFileSync(nextPath, buildFullDraft(changeDescriptions, recommended, hasFix));
    return 'wrote full draft (guide was absent or a pristine template)';
  }

  // Human content present — additive, never-clobber. Regenerate only the
  // uncovered-delta block (idempotent). Coverage is measured against the
  // HUMAN content only: strip any prior auto-block first, otherwise the
  // block's own text would count as "coverage" and the block would
  // oscillate (present on one run, absent the next).
  const beginIdx = existing.indexOf(UNCOVERED_BEGIN);
  const endIdx = existing.indexOf(UNCOVERED_END);
  let tail = '';
  let humanContent = existing;
  if (beginIdx !== -1) {
    tail = endIdx !== -1 ? existing.slice(endIdx + UNCOVERED_END.length) : '';
    humanContent = existing.slice(0, beginIdx) + tail;
  }
  const block = buildUncoveredBlock(changeDescriptions, humanContent);
  let body;
  if (beginIdx !== -1) {
    body = existing.slice(0, beginIdx).replace(/\s+$/, '') + (block ? `\n\n${block}` : '') + tail;
  } else if (block) {
    body = existing.replace(/\s+$/, '') + `\n\n${block}\n`;
  } else {
    return 'no uncovered changes — guide already covers the change-list';
  }
  fs.writeFileSync(nextPath, body);
  return block ? 'merged uncovered-delta block into existing guide' : 'removed stale uncovered-delta block (now fully covered)';
}

// ── Main ─────────────────────────────────────────────────────────────

const lastTag = getLastReleaseTag();
const commits = getCommitsSinceTag(lastTag);
const changedFiles = getChangedFiles(lastTag);

if (commits.length === 0) {
  log('No commits since last release tag. Nothing to analyze.');
  process.exit(0);
}

log(`\n  Release Change Analysis`);
log(`  ${'─'.repeat(50)}`);
log(`  Last release: ${lastTag}`);
log(`  Commits since: ${commits.length}`);
log(`  Files changed: ${changedFiles.length}`);

// Run all analyses
const analysis = {
  routes: analyzeRouteChanges(lastTag, changedFiles),
  cli: analyzeCLIChanges(lastTag, changedFiles),
  config: analyzeConfigChanges(lastTag, changedFiles),
  exports: analyzeExportChanges(lastTag, changedFiles),
  files: analyzeFileChanges(changedFiles),
  commits: classifyCommits(commits),
};

// Generate recommendations
const bumpRecommendation = recommendBumpType(analysis);
const changeDescriptions = generateChangeDescriptions(analysis);

log(`\n  Commit Classification:`);
log(`    Features: ${analysis.commits.features.length}`);
log(`    Fixes:    ${analysis.commits.fixes.length}`);
log(`    Refactors: ${analysis.commits.refactors.length}`);
log(`    Tests:    ${analysis.commits.tests.length}`);
log(`    Docs:     ${analysis.commits.docs.length}`);
log(`    Breaking: ${analysis.commits.breaking.length}`);

log(`\n  Structural Changes:`);
log(`    New endpoints:     ${analysis.routes.newEndpoints.length}`);
log(`    Removed endpoints: ${analysis.routes.removedEndpoints.length}`);
log(`    New CLI commands:  ${analysis.cli.newCommands.length}`);
log(`    New config fields: ${analysis.config.newConfigFields.length}`);
log(`    New exports:       ${analysis.exports.newExports.length}`);
log(`    Removed exports:   ${analysis.exports.removedExports.length}`);

log(`\n  Recommended Bump: ${bumpRecommendation.recommended.toUpperCase()}`);
if (bumpRecommendation.majorSignals.length > 0) {
  log(`    Major signals:`);
  for (const s of bumpRecommendation.majorSignals) log(`      - ${s}`);
}
if (bumpRecommendation.minorSignals.length > 0) {
  log(`    Minor signals:`);
  for (const s of bumpRecommendation.minorSignals) log(`      - ${s}`);
}
if (bumpRecommendation.patchSignals.length > 0) {
  log(`    Patch signals:`);
  for (const s of bumpRecommendation.patchSignals) log(`      - ${s}`);
}

if (DRAFT_GUIDE) {
  const hasFix = analysis.commits.fixes.length > 0;
  const status = writeOrMergeGuide(changeDescriptions, bumpRecommendation.recommended, hasFix);
  log(`\n  Draft guide: ${status}`);
  console.log(status);
  process.exit(0);
}

if (RECOMMEND_ONLY) {
  console.log(bumpRecommendation.recommended);
  process.exit(0);
}

// ── Guide Coverage Validation ────────────────────────────────────────

let exitCode = 0;
let guideCoverage = { gaps: [], guideFound: false };

// Find the upgrade guide (check both NEXT.md and version-specific)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
const guidePath = path.join(ROOT, 'upgrades', `${version}.md`);
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');

let guideContent = '';
let guideFile = '';

if (fs.existsSync(guidePath)) {
  guideContent = fs.readFileSync(guidePath, 'utf-8');
  guideFile = `upgrades/${version}.md`;
} else if (fs.existsSync(nextPath)) {
  guideContent = fs.readFileSync(nextPath, 'utf-8');
  guideFile = 'upgrades/NEXT.md';
}

if (guideContent) {
  guideCoverage.guideFound = true;
  guideCoverage.gaps = validateGuideCoverage(analysis, guideContent);

  // Check declared bump type against recommendation
  const declaredMatch = /<!--\s*bump:\s*(patch|minor|major)\s*-->/.exec(guideContent);
  const declaredBump = declaredMatch ? declaredMatch[1] : null;

  if (declaredBump && declaredBump !== bumpRecommendation.recommended) {
    // Only block if the recommendation is MORE severe
    const severity = { patch: 0, minor: 1, major: 2 };
    if (severity[bumpRecommendation.recommended] > severity[declaredBump]) {
      guideCoverage.gaps.push({
        type: 'bump-mismatch',
        severity: 'critical',
        detail: `Guide declares "${declaredBump}" but analysis recommends "${bumpRecommendation.recommended}": ${
          bumpRecommendation.recommended === 'major'
            ? bumpRecommendation.majorSignals.join(', ')
            : bumpRecommendation.minorSignals.join(', ')
        }`,
      });
    }
  }

  const criticalGaps = guideCoverage.gaps.filter(g => g.severity === 'critical');
  const highGaps = guideCoverage.gaps.filter(g => g.severity === 'high');

  if (criticalGaps.length > 0 || highGaps.length > 0) {
    log(`\n  ✗ Upgrade guide coverage issues found:`);
    for (const gap of [...criticalGaps, ...highGaps]) {
      log(`    [${gap.severity.toUpperCase()}] ${gap.detail}`);
    }
    exitCode = 1;
  }

  const mediumGaps = guideCoverage.gaps.filter(g => g.severity === 'medium');
  const lowGaps = guideCoverage.gaps.filter(g => g.severity === 'low');

  if (mediumGaps.length > 0 || lowGaps.length > 0) {
    log(`\n  ⚠ Advisory coverage gaps:`);
    for (const gap of [...mediumGaps, ...lowGaps]) {
      log(`    [${gap.severity}] ${gap.detail}`);
    }
  }

  if (guideCoverage.gaps.length === 0) {
    log(`\n  ✓ Upgrade guide adequately covers all detected changes.`);
  }

  // Silent-by-default author guard (mature-update-announcements spec, D3):
  // when a release ships user-relevant changes but the guide carries NO
  // `user_announcement` block at all, every change is silent to the user. That
  // is correct for an all-internal release, but it is also exactly what a
  // forgotten block looks like. Emit a NON-BLOCKING advisory so the author
  // consciously decides — `instar` analyze --draft-guide scaffolds the block
  // (defaulting agent-only), so its total absence means the scaffold was
  // bypassed. Structure informs; the author decides (never blocks).
  const userRelevantChanges = changeDescriptions.filter(
    (d) => d.type === 'feature' || d.type === 'enhancement',
  ).length;
  if (userRelevantChanges > 0 && !/^\s*user_announcement\s*:/m.test(guideContent)) {
    log(
      `\n  ⚠ This release has ${userRelevantChanges} user-relevant change(s) but the guide has no ` +
        `\`user_announcement\` block — nothing will be announced to the user. If any change is ` +
        `user-ready, add a block (\`audience: user\` + a maturity); otherwise this silence is correct.`,
    );
  }
} else {
  log(`\n  ⚠ No upgrade guide found — cannot validate coverage.`);
}

// ── Output Report ────────────────────────────────────────────────────

const report = {
  lastTag,
  commitCount: commits.length,
  fileCount: changedFiles.length,
  analysis: {
    routes: analysis.routes,
    cli: analysis.cli,
    config: analysis.config,
    exports: analysis.exports,
    commitClassification: {
      features: analysis.commits.features.length,
      fixes: analysis.commits.fixes.length,
      refactors: analysis.commits.refactors.length,
      tests: analysis.commits.tests.length,
      docs: analysis.commits.docs.length,
      breaking: analysis.commits.breaking.length,
    },
    fileClassification: {
      newFiles: analysis.files.newFiles.length,
      deletedFiles: analysis.files.deletedFiles.length,
      modifiedFiles: analysis.files.modifiedFiles.length,
      srcChanges: analysis.files.srcChanges.length,
      testChanges: analysis.files.testChanges.length,
    },
  },
  recommendation: bumpRecommendation,
  changeDescriptions,
  guideCoverage: {
    guideFile,
    guideFound: guideCoverage.guideFound,
    gaps: guideCoverage.gaps,
    criticalGaps: guideCoverage.gaps.filter(g => g.severity === 'critical').length,
    highGaps: guideCoverage.gaps.filter(g => g.severity === 'high').length,
  },
};

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log(`\n  Change Descriptions (${changeDescriptions.length} items):`);
  for (const desc of changeDescriptions) {
    log(`    [${desc.type}] ${desc.summary}`);
  }
  log('');
}

process.exit(exitCode);
