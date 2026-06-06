/**
 * skillParityRule — parity rule for the Skill functional primitive.
 *
 * Specs:
 *   - specs/instar-concepts/skill.md (canonical shape)
 *   - specs/frameworks/claude-code/skills.md (Claude rendering contract)
 *   - specs/frameworks/codex-cli/skills.md (Codex rendering contract)
 *
 * Reads canonical skills from `.instar/skills/<name>/` and verifies each
 * framework's rendering is in sync. On drift, the sentinel can call
 * remediate() to re-render from canonical.
 *
 * Convergence-round-1 hardening applied:
 *   - C1: strict slug grammar enforced at every entry point (path traversal
 *     and arbitrary-write are no longer reachable from canonical content).
 *   - C2: YAML parsing via js-yaml; fail-loud on parse error rather than
 *     silent truncation by regex.
 *   - C5: symmetric verify — orphan rendered files surfaced as
 *     `orphan-rendering-found`; remediate cleans them.
 *   - C7: rendered files carry an `x-instar-stamp` tag recording the
 *     canonical body hash that produced them. user-edits to renderings are
 *     detected and surfaced as `user-edit-conflict`; auto-remediate
 *     refuses to overwrite without explicit force.
 *   - C8: description length capped + control chars stripped at parse time
 *     to bound prompt-injection surface.
 *   - H1: directory name vs frontmatter `name` mismatch surfaced as
 *     `name-directory-mismatch`.
 *   - H5: canonical-read errors tagged with `framework: 'canonical'` rather
 *     than misleadingly attributing to a framework.
 *
 * Deferred to follow-up issues (tracked, not in this PR):
 *   - C3: render `allowed-tools` → Claude frontmatter + Codex
 *     `dependencies.tools`. Removed from canonical for v0.1 to avoid
 *     promise-without-delivery drift; will land with the Tool primitive.
 *   - C6: atomic-write tempfile+rename. Single-sentinel-pass + single-
 *     machine narrows the race window for v0.1; will add when sentinel
 *     ships.
 *   - H2/H3: BackupManager defaults + CLAUDE.md template — separate PRs.
 *   - H4: git-sync conflict-marker detection — operator-facing; surfaced
 *     in this PR as fail-loud `canonical-parse-error`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import type { IntelligenceFramework } from '../../../core/intelligenceProviderFactory.js';
import type {
  ParityRule,
  ParityMismatch,
  VerifyResult,
} from '../types.js';

const CANONICAL_ROOT = '.instar/skills';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_LEN = 256;
const MAX_NAME_LEN = 64;
const STAMP_KEY = 'x-instar-stamp';
const STAMP_LINE_RE = /^x-instar-stamp:\s*([a-f0-9]{64})\s*$/m;

interface CanonicalSkill {
  name: string;
  description: string;
  metadataShortDescription?: string;
  body: string;
  bundledSubdirs: ReadonlyArray<'scripts' | 'references' | 'assets'>;
  /** sha256 of body — used for stamp tracking */
  bodyHash: string;
}

interface FrameworkRenderer {
  skillMdPath(projectRoot: string, name: string): string;
  skillDir(projectRoot: string, name: string): string;
  render(projectRoot: string, skill: CanonicalSkill, opts?: { force?: boolean }): Promise<void>;
  verifyRendering(projectRoot: string, skill: CanonicalSkill): Promise<Array<{
    reasonCode: ParityMismatch['reasonCode'];
    detail: string;
  }>>;
  /** Remove rendered files that have no canonical counterpart. */
  removeOrphans(projectRoot: string, canonicalNames: Set<string>): Promise<string[]>;
}

// ─── Slug + description validation ──────────────────────────────────────

export class CanonicalSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalSkillError';
  }
}

function validateSlug(name: string, context: string): void {
  if (typeof name !== 'string' || !SLUG_RE.test(name)) {
    throw new CanonicalSkillError(
      `${context}: invalid skill name "${name}". Must match ${SLUG_RE.source} ` +
        `(lowercase alphanumeric + hyphens, max ${MAX_NAME_LEN} chars).`,
    );
  }
}

function sanitizeDescription(raw: string): string {
  // Strip control chars, collapse whitespace, cap length. Bounds
  // prompt-injection surface and keeps metadata-layer payload small.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_DESCRIPTION_LEN
    ? cleaned.slice(0, MAX_DESCRIPTION_LEN - 3) + '...'
    : cleaned;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

// ─── Canonical loader ──────────────────────────────────────────────────

interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(raw: string, sourcePath: string): ParsedFrontmatter {
  // Detect git-merge-conflict markers and fail loud rather than parsing past them.
  if (/^<{7} |^={7}$|^>{7} /m.test(raw)) {
    throw new CanonicalSkillError(
      `${sourcePath}: file contains unresolved git merge conflict markers`,
    );
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new CanonicalSkillError(`${sourcePath}: missing YAML frontmatter block`);
  }
  const [, fmRaw, body] = match;
  let fm: unknown;
  try {
    fm = yaml.load(fmRaw, { schema: yaml.FAILSAFE_SCHEMA, json: false });
  } catch (err) {
    throw new CanonicalSkillError(
      `${sourcePath}: YAML frontmatter parse error — ${(err as Error).message}`,
    );
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new CanonicalSkillError(`${sourcePath}: frontmatter must be a YAML mapping`);
  }
  return { fm: fm as Record<string, unknown>, body };
}

async function readCanonicalSkill(projectRoot: string, dirName: string): Promise<CanonicalSkill> {
  validateSlug(dirName, `canonical skill dir name`);
  const skillDir = path.join(projectRoot, CANONICAL_ROOT, dirName);
  const skillMd = path.join(skillDir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(skillMd, 'utf-8');
  } catch (err) {
    throw new CanonicalSkillError(
      `canonical SKILL.md missing or unreadable: ${path.relative(projectRoot, skillMd)} — ${(err as Error).message}`,
    );
  }
  const { fm, body } = parseFrontmatter(raw, path.relative(projectRoot, skillMd));

  const name = fm.name;
  const description = fm.description;
  if (typeof name !== 'string') {
    throw new CanonicalSkillError(
      `${path.relative(projectRoot, skillMd)}: frontmatter 'name' must be a string`,
    );
  }
  if (typeof description !== 'string') {
    throw new CanonicalSkillError(
      `${path.relative(projectRoot, skillMd)}: frontmatter 'description' must be a string`,
    );
  }
  validateSlug(name, `${path.relative(projectRoot, skillMd)}: frontmatter 'name'`);
  if (name !== dirName) {
    throw new CanonicalSkillError(
      `${path.relative(projectRoot, skillMd)}: frontmatter 'name'="${name}" does not match directory name "${dirName}". Directory name is authoritative.`,
    );
  }

  let metadataShortDescription: string | undefined;
  const metadataRaw = fm.metadata;
  if (metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)) {
    const md = metadataRaw as Record<string, unknown>;
    const short = md['short-description'] ?? md['short_description'];
    if (typeof short === 'string') {
      metadataShortDescription = sanitizeDescription(short);
    }
  }

  const cleanedDescription = sanitizeDescription(description);

  const bundledSubdirs: Array<'scripts' | 'references' | 'assets'> = [];
  for (const sub of ['scripts', 'references', 'assets'] as const) {
    try {
      const st = await fs.stat(path.join(skillDir, sub));
      if (st.isDirectory()) bundledSubdirs.push(sub);
    } catch {
      /* not present */
    }
  }

  return {
    name,
    description: cleanedDescription,
    metadataShortDescription,
    body,
    bundledSubdirs,
    bodyHash: sha256(body),
  };
}

async function listCanonicalSkillNames(projectRoot: string): Promise<string[]> {
  const dir = path.join(projectRoot, CANONICAL_ROOT);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// ─── Mirror + compare helpers ──────────────────────────────────────────

async function mirrorSubdir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Skip symlinks — they can escape the canonical tree.
      continue;
    }
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mirrorSubdir(s, d);
    } else {
      const content = await fs.readFile(s);
      await fs.writeFile(d, content);
    }
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function compareSubdirs(src: string, dest: string): Promise<{
  matches: boolean;
  reason?: string;
}> {
  let srcEntries: Array<{ name: string; isDir: boolean }>;
  let destEntries: Array<{ name: string; isDir: boolean }>;
  try {
    srcEntries = (await fs.readdir(src, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    srcEntries = [];
  }
  try {
    destEntries = (await fs.readdir(dest, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return { matches: false, reason: `destination subdir missing: ${dest}` };
  }

  const srcNames = new Set(srcEntries.map((e) => e.name));
  const destNames = new Set(destEntries.map((e) => e.name));
  for (const name of srcNames) {
    if (!destNames.has(name)) return { matches: false, reason: `missing entry ${name}` };
  }
  for (const name of destNames) {
    if (!srcNames.has(name)) return { matches: false, reason: `extraneous entry ${name}` };
  }
  for (const e of srcEntries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDir) {
      const r = await compareSubdirs(s, d);
      if (!r.matches) return r;
    } else {
      const sBuf = await fs.readFile(s);
      const dBuf = await fs.readFile(d);
      if (sBuf.compare(dBuf) !== 0) {
        return { matches: false, reason: `content mismatch in ${path.relative(src, s)}` };
      }
    }
  }
  return { matches: true };
}

// ─── Stamp parsing ──────────────────────────────────────────────────────

function extractStamp(rendered: string): string | null {
  const m = rendered.match(STAMP_LINE_RE);
  return m ? m[1] : null;
}

// ─── Per-framework renderers ───────────────────────────────────────────

const claudeCodeRenderer: FrameworkRenderer = {
  skillDir(projectRoot, name) {
    validateSlug(name, 'claude-code skillDir');
    return path.join(projectRoot, '.claude/skills', name);
  },
  skillMdPath(projectRoot, name) {
    return path.join(this.skillDir(projectRoot, name), 'SKILL.md');
  },

  async render(projectRoot, skill) {
    const skillDir = this.skillDir(projectRoot, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    const fmLines = [
      '---',
      `name: ${skill.name}`,
      `description: ${JSON.stringify(skill.description).slice(1, -1)}`,
      `${STAMP_KEY}: ${skill.bodyHash}`,
      '---',
      '',
    ].join('\n');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), fmLines + skill.body, 'utf-8');
    const canonicalDir = path.join(projectRoot, CANONICAL_ROOT, skill.name);
    for (const sub of skill.bundledSubdirs) {
      await mirrorSubdir(path.join(canonicalDir, sub), path.join(skillDir, sub));
    }
  },

  async verifyRendering(projectRoot, skill) {
    const issues: Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }> = [];
    const skillMd = this.skillMdPath(projectRoot, skill.name);
    const rendered = await readFileOrNull(skillMd);
    if (!rendered) {
      issues.push({
        reasonCode: 'missing-rendered-file',
        detail: `expected ${path.relative(projectRoot, skillMd)} to exist`,
      });
      return issues;
    }
    let parsed: ParsedFrontmatter;
    try {
      parsed = parseFrontmatter(rendered, path.relative(projectRoot, skillMd));
    } catch (err) {
      issues.push({
        reasonCode: 'rendering-parse-error',
        detail: (err as Error).message,
      });
      return issues;
    }
    if (parsed.fm.name !== skill.name) {
      issues.push({
        reasonCode: 'frontmatter-name-mismatch',
        detail: `claude rendering 'name'=${parsed.fm.name} vs canonical=${skill.name}`,
      });
    }
    if (parsed.fm.description !== skill.description) {
      issues.push({
        reasonCode: 'frontmatter-description-mismatch',
        detail: `claude rendering 'description' differs from canonical`,
      });
    }
    if (parsed.body !== skill.body) {
      const stamp = extractStamp(rendered);
      if (stamp && stamp === skill.bodyHash) {
        issues.push({
          reasonCode: 'user-edit-conflict',
          detail: `claude rendering body differs from canonical, but stamp matches current canonical hash — user appears to have edited the rendering directly`,
        });
      } else {
        issues.push({
          reasonCode: 'body-content-mismatch',
          detail: `claude rendering body differs from canonical (stamp ${stamp ? 'stale' : 'missing'})`,
        });
      }
    }
    const canonicalDir = path.join(projectRoot, CANONICAL_ROOT, skill.name);
    const renderedDir = this.skillDir(projectRoot, skill.name);
    for (const sub of skill.bundledSubdirs) {
      const cmp = await compareSubdirs(path.join(canonicalDir, sub), path.join(renderedDir, sub));
      if (!cmp.matches) {
        issues.push({
          reasonCode: cmp.reason?.startsWith('destination subdir missing')
            ? 'bundled-subdir-missing'
            : 'bundled-subdir-mismatch',
          detail: `claude rendering ${sub}/: ${cmp.reason}`,
        });
      }
    }
    return issues;
  },

  async removeOrphans(projectRoot, canonicalNames) {
    const skillsRoot = path.join(projectRoot, '.claude/skills');
    return removeOrphanSkillDirs(skillsRoot, canonicalNames);
  },
};

function humanizeName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function shortDescriptionFor(skill: CanonicalSkill): string {
  const raw = skill.metadataShortDescription ?? skill.description;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 64) return oneLine;
  return oneLine.slice(0, 61).trimEnd() + '...';
}

function buildOpenAiYaml(skill: CanonicalSkill): string {
  const obj = {
    interface: {
      display_name: humanizeName(skill.name),
      short_description: shortDescriptionFor(skill),
    },
    [STAMP_KEY]: skill.bodyHash,
  };
  return yaml.dump(obj, { lineWidth: 200, noRefs: true });
}

const codexCliRenderer: FrameworkRenderer = {
  skillDir(projectRoot, name) {
    validateSlug(name, 'codex-cli skillDir');
    return path.join(projectRoot, '.agents/skills', name);
  },
  skillMdPath(projectRoot, name) {
    return path.join(this.skillDir(projectRoot, name), 'SKILL.md');
  },

  async render(projectRoot, skill) {
    const skillDir = this.skillDir(projectRoot, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    const fmObj: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.metadataShortDescription) {
      fmObj.metadata = { 'short-description': skill.metadataShortDescription };
    }
    fmObj[STAMP_KEY] = skill.bodyHash;
    const fmYaml = yaml.dump(fmObj, { lineWidth: 200, noRefs: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\n${fmYaml}---\n${skill.body}`,
      'utf-8',
    );

    const yamlDir = path.join(skillDir, 'agents');
    await fs.mkdir(yamlDir, { recursive: true });
    await fs.writeFile(path.join(yamlDir, 'openai.yaml'), buildOpenAiYaml(skill), 'utf-8');

    const canonicalDir = path.join(projectRoot, CANONICAL_ROOT, skill.name);
    for (const sub of skill.bundledSubdirs) {
      await mirrorSubdir(path.join(canonicalDir, sub), path.join(skillDir, sub));
    }
  },

  async verifyRendering(projectRoot, skill) {
    const issues: Array<{ reasonCode: ParityMismatch['reasonCode']; detail: string }> = [];
    const skillMd = this.skillMdPath(projectRoot, skill.name);
    const rendered = await readFileOrNull(skillMd);
    if (!rendered) {
      issues.push({
        reasonCode: 'missing-rendered-file',
        detail: `expected ${path.relative(projectRoot, skillMd)} to exist`,
      });
      return issues;
    }
    let parsed: ParsedFrontmatter;
    try {
      parsed = parseFrontmatter(rendered, path.relative(projectRoot, skillMd));
    } catch (err) {
      issues.push({
        reasonCode: 'rendering-parse-error',
        detail: (err as Error).message,
      });
      return issues;
    }
    if (parsed.fm.name !== skill.name) {
      issues.push({
        reasonCode: 'frontmatter-name-mismatch',
        detail: `codex rendering 'name'=${parsed.fm.name} vs canonical=${skill.name}`,
      });
    }
    if (parsed.fm.description !== skill.description) {
      issues.push({
        reasonCode: 'frontmatter-description-mismatch',
        detail: `codex rendering 'description' differs from canonical`,
      });
    }
    if (parsed.body !== skill.body) {
      const stamp = extractStamp(rendered);
      if (stamp && stamp === skill.bodyHash) {
        issues.push({
          reasonCode: 'user-edit-conflict',
          detail: `codex rendering body differs from canonical, but stamp matches current canonical hash — user appears to have edited the rendering directly`,
        });
      } else {
        issues.push({
          reasonCode: 'body-content-mismatch',
          detail: `codex rendering body differs from canonical (stamp ${stamp ? 'stale' : 'missing'})`,
        });
      }
    }
    const yamlPath = path.join(this.skillDir(projectRoot, skill.name), 'agents/openai.yaml');
    const yamlRaw = await readFileOrNull(yamlPath);
    if (!yamlRaw) {
      issues.push({
        reasonCode: 'sibling-artifact-missing',
        detail: `expected ${path.relative(projectRoot, yamlPath)} to exist`,
      });
    } else {
      const expectedYaml = buildOpenAiYaml(skill);
      if (yamlRaw !== expectedYaml) {
        issues.push({
          reasonCode: 'sibling-artifact-mismatch',
          detail: `codex openai.yaml differs from canonical-derived expected`,
        });
      }
    }
    const canonicalDir = path.join(projectRoot, CANONICAL_ROOT, skill.name);
    const renderedDir = this.skillDir(projectRoot, skill.name);
    for (const sub of skill.bundledSubdirs) {
      const cmp = await compareSubdirs(path.join(canonicalDir, sub), path.join(renderedDir, sub));
      if (!cmp.matches) {
        issues.push({
          reasonCode: cmp.reason?.startsWith('destination subdir missing')
            ? 'bundled-subdir-missing'
            : 'bundled-subdir-mismatch',
          detail: `codex rendering ${sub}/: ${cmp.reason}`,
        });
      }
    }
    return issues;
  },

  async removeOrphans(projectRoot, canonicalNames) {
    const skillsRoot = path.join(projectRoot, '.agents/skills');
    return removeOrphanSkillDirs(skillsRoot, canonicalNames);
  },
};

async function removeOrphanSkillDirs(
  skillsRoot: string,
  canonicalNames: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = (await fs.readdir(skillsRoot, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (canonicalNames.has(entry.name)) continue;
    // Only remove dirs whose name is a valid slug — refuse to touch anything
    // unexpected (paranoid: don't widen the blast radius).
    if (!SLUG_RE.test(entry.name)) continue;
    const fullPath = path.join(skillsRoot, entry.name);
    await fs.rm(fullPath, { recursive: true, force: true });
    removed.push(fullPath);
  }
  return removed;
}

const FRAMEWORK_RENDERERS: Record<IntelligenceFramework, FrameworkRenderer> = {
  'claude-code': claudeCodeRenderer,
  'codex-cli': codexCliRenderer,
  // Gemini CLI (apprenticeship Step 2 minimal body): reuses the non-Claude
  // `.agents/skills` shared-layout renderer. Skill-rendering PARITY for gemini
  // (a gemini-specific sibling YAML if/when one is needed) is §9 ongoing
  // apprenticeship work — the parity harness is dormant in production
  // (src/providers/registry is unregistered), so this entry keeps the
  // compiler-forced Record total without overclaiming a gemini-native artifact
  // that the minimal body does not yet produce.
  'gemini-cli': codexCliRenderer,
  // pi (PI-HARNESS-INTEGRATION-SPEC Phase A): same rationale as gemini — pi
  // natively discovers skills + AGENTS.md from the project tree, and the
  // shared `.agents/skills` layout is the non-Claude convention. A pi-native
  // rendering (pi's own skill format via `--skill`) is a Phase E refinement;
  // this entry keeps the compiler-forced Record total without overclaiming.
  'pi-cli': codexCliRenderer,
};

// ─── The exported ParityRule ───────────────────────────────────────────

async function findOrphans(
  projectRoot: string,
  framework: IntelligenceFramework,
  canonicalNames: Set<string>,
): Promise<ParityMismatch[]> {
  const renderer = FRAMEWORK_RENDERERS[framework];
  const skillsRoot = framework === 'claude-code'
    ? path.join(projectRoot, '.claude/skills')
    : path.join(projectRoot, '.agents/skills');
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = (await fs.readdir(skillsRoot, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return [];
  }
  const orphans: ParityMismatch[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (!SLUG_RE.test(entry.name)) continue;
    if (canonicalNames.has(entry.name)) continue;
    orphans.push({
      primitive: 'skill',
      instanceName: entry.name,
      framework,
      reasonCode: 'orphan-rendering-found',
      detail: `rendered skill dir has no canonical counterpart: ${path.relative(projectRoot, renderer.skillDir(projectRoot, entry.name))}`,
    });
  }
  return orphans;
}

export const skillParityRule: ParityRule = {
  primitive: 'skill',
  frameworks: ['claude-code', 'codex-cli'],
  remediationPolicy: 'mirror-trust',

  async listInstances(projectRoot) {
    return listCanonicalSkillNames(projectRoot);
  },

  async verify(projectRoot, instanceName): Promise<VerifyResult> {
    let skill: CanonicalSkill;
    try {
      skill = await readCanonicalSkill(projectRoot, instanceName);
    } catch (err: unknown) {
      return {
        ok: false,
        mismatches: [
          {
            primitive: 'skill',
            instanceName,
            framework: 'canonical',
            reasonCode: 'canonical-read-error',
            detail: `canonical skill could not be read: ${(err as Error).message}`,
          },
        ],
      };
    }

    const mismatches: ParityMismatch[] = [];
    for (const framework of this.frameworks) {
      const renderer = FRAMEWORK_RENDERERS[framework];
      const issues = await renderer.verifyRendering(projectRoot, skill);
      for (const issue of issues) {
        mismatches.push({
          primitive: 'skill',
          instanceName,
          framework,
          reasonCode: issue.reasonCode,
          detail: issue.detail,
        });
      }
    }
    return { ok: mismatches.length === 0, mismatches };
  },

  async remediate(projectRoot, instanceName, framework) {
    const skill = await readCanonicalSkill(projectRoot, instanceName);
    const renderer = FRAMEWORK_RENDERERS[framework];
    // C7: refuse to overwrite if the current rendering is a user-edit-conflict.
    // Sentinel/operator must explicitly resolve before remediation proceeds.
    const issues = await renderer.verifyRendering(projectRoot, skill);
    const conflict = issues.find((i) => i.reasonCode === 'user-edit-conflict');
    if (conflict) {
      throw new CanonicalSkillError(
        `refused to remediate ${instanceName} on ${framework}: ${conflict.detail}. ` +
          `Resolve the user-edit-conflict explicitly before re-running.`,
      );
    }
    await renderer.render(projectRoot, skill);
  },

  async listOrphans(projectRoot): Promise<ParityMismatch[]> {
    const canonical = new Set(await listCanonicalSkillNames(projectRoot));
    const out: ParityMismatch[] = [];
    for (const framework of this.frameworks) {
      out.push(...(await findOrphans(projectRoot, framework, canonical)));
    }
    return out;
  },

  async removeOrphans(projectRoot, framework): Promise<string[]> {
    const canonical = new Set(await listCanonicalSkillNames(projectRoot));
    const renderer = FRAMEWORK_RENDERERS[framework];
    return renderer.removeOrphans(projectRoot, canonical);
  },
};
