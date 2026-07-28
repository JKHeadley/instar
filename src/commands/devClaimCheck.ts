/**
 * `instar dev:claim-check [paths...]` — PRE-BUILD advisory: is another PR (open
 * OR freshly merged) or an approved spec already claiming the files you are
 * about to build on?
 *
 * Why this exists: on 2026-06-05 two pairs of parallel sessions built fixes for
 * the SAME incident twice in one night (#802 re-scoped against a sibling's
 * spec; #810 superseded #808's SecretStore layer mid-CI). Each collision burned
 * a full rework cycle. Topic-level parallel-work awareness (`GET
 * /parallel-work/activities`) doesn't see PR/spec-level claims — this command
 * does, at the moment it matters: BEFORE the build starts.
 *
 * Sources checked:
 *  1. OPEN PRs — file-path overlap (the in-flight claim).
 *  2. Recently-MERGED PRs (default 2 days) — the #810 case: the claim already
 *     landed but may not be in your base/branch yet.
 *  3. Local `docs/specs/*.md` — keyword match against spec titles/headers when
 *     `--keywords` is given (the #802 case: a converged spec owns a layer
 *     before any PR exists).
 *
 * Advisory by default (always exit 0); `--strict` exits 1 on any overlap so it
 * can gate a scripted flow. Read-only: GET-only `gh` calls + local reads.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

/** Subset of `gh pr list --json` output we use. */
export interface ClaimPr {
  number: number;
  title: string;
  headRefName?: string;
  updatedAt?: string;
  state?: string;
  files?: Array<{ path: string }>;
}

export interface ClaimCheckOutput {
  write(text: string): void;
  error(text: string): void;
}

/** Injectable `gh` boundary so the command is unit-testable without the network. */
export interface ClaimCheckDeps {
  /** Run a `gh` invocation and return its parsed JSON stdout (or throw). */
  ghJson(args: string[]): Promise<unknown>;
  /** Read a spec dir; injectable for tests. Defaults to fs. */
  readSpecs?(specsDir: string): Array<{ file: string; head: string }>;
}

export interface DevClaimCheckOptions {
  /** Files you intend to touch (relative to repo root). */
  paths: string[];
  /** Optional keywords to match against docs/specs titles/headers. */
  keywords?: string[];
  /** Look-back window for merged PRs, in days (default 2). */
  mergedDays?: number;
  repo?: string;
  /** Exit 1 when any overlap is found. */
  strict?: boolean;
  /** Repo root for the spec scan (default cwd). */
  rootDir?: string;
  output?: ClaimCheckOutput;
  deps?: ClaimCheckDeps;
}

const DEFAULT_REPO = 'JKHeadley/instar';
const DEFAULT_MERGED_DAYS = 2;
/** Spec-scan reads only the head of each file — titles + frontmatter live there. */
const SPEC_HEAD_BYTES = 2048;

export interface PrOverlap {
  pr: ClaimPr;
  overlap: string[];
  bucket: 'open' | 'merged';
}

/**
 * Pure: which of `prs` touch any of `targetPaths`?
 * Overlap is exact-path OR directory-prefix in either direction, so claiming
 * `src/core/` collides with a PR touching `src/core/SecretStore.ts` and vice
 * versa.
 */
export function findPrOverlaps(targetPaths: string[], prs: ClaimPr[], bucket: 'open' | 'merged'): PrOverlap[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const targets = targetPaths.map(norm).filter(Boolean);
  const out: PrOverlap[] = [];
  for (const pr of prs) {
    const prFiles = (pr.files ?? []).map((f) => norm(f.path));
    const overlap = new Set<string>();
    for (const t of targets) {
      for (const f of prFiles) {
        if (f === t || f.startsWith(`${t}/`) || t.startsWith(`${f}/`)) overlap.add(f);
      }
    }
    if (overlap.size > 0) out.push({ pr, overlap: [...overlap].sort(), bucket });
  }
  return out;
}

export interface SpecMatch {
  file: string;
  matched: string[];
}

/**
 * Pure: which spec heads mention any of the keywords (case-insensitive)?
 * Word-ish matching: a keyword hits on substring presence — specs are prose,
 * precision matters less than recall here (the reader judges relevance).
 */
export function findSpecMatches(
  specs: Array<{ file: string; head: string }>,
  keywords: string[],
): SpecMatch[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (kws.length === 0) return [];
  const out: SpecMatch[] = [];
  for (const s of specs) {
    const head = s.head.toLowerCase();
    const matched = kws.filter((k) => head.includes(k));
    if (matched.length > 0) out.push({ file: s.file, matched });
  }
  return out;
}

/** Default spec reader: head of every .md directly under docs/specs/. */
export function readSpecHeads(specsDir: string): Array<{ file: string; head: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(specsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // no specs dir (non-instar repo) — nothing to scan
  }
  const out: Array<{ file: string; head: string }> = [];
  for (const f of entries) {
    try {
      const fd = fs.openSync(path.join(specsDir, f), 'r');
      try {
        const buf = Buffer.alloc(SPEC_HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, SPEC_HEAD_BYTES, 0);
        out.push({ file: f, head: buf.toString('utf-8', 0, n) });
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // unreadable spec file — skip it; the scan is advisory
    }
  }
  return out;
}

function defaultGhJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout || 'null'));
      } catch (parseErr) {
        reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
      }
    });
  });
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Run the claim check. Returns the process exit code.
 */
export async function runDevClaimCheck(options: DevClaimCheckOptions): Promise<number> {
  const output: ClaimCheckOutput = options.output ?? {
    write: (t) => process.stdout.write(`${t}\n`),
    error: (t) => process.stderr.write(`${t}\n`),
  };
  const ghJson = options.deps?.ghJson ?? defaultGhJson;
  const readSpecs = options.deps?.readSpecs ?? readSpecHeads;
  const repo = options.repo ?? DEFAULT_REPO;
  const mergedDays = options.mergedDays ?? DEFAULT_MERGED_DAYS;

  if (options.paths.length === 0 && (options.keywords ?? []).length === 0) {
    output.error(pc.red('Nothing to check: pass file paths (e.g. src/core/SecretStore.ts) and/or --keywords.'));
    return 2;
  }

  const fields = 'number,title,headRefName,updatedAt,files';
  let openPrs: ClaimPr[] = [];
  let mergedPrs: ClaimPr[] = [];
  let ghDegraded: string | null = null;
  if (options.paths.length > 0) {
    try {
      openPrs = (await ghJson([
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', fields,
      ])) as ClaimPr[] ?? [];
      mergedPrs = (await ghJson([
        'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '50', '--json', fields,
        '--search', `merged:>=${isoDaysAgo(mergedDays)}`,
      ])) as ClaimPr[] ?? [];
    } catch (err) {
      // Advisory tool: a network/gh failure degrades to spec-scan-only, LOUDLY.
      ghDegraded = err instanceof Error ? err.message : String(err);
    }
  }

  const openOverlaps = findPrOverlaps(options.paths, openPrs, 'open');
  const mergedOverlaps = findPrOverlaps(options.paths, mergedPrs, 'merged');
  const specMatches = findSpecMatches(
    readSpecs(path.join(options.rootDir ?? process.cwd(), 'docs', 'specs')),
    options.keywords ?? [],
  );

  output.write(pc.bold(`claim-check — ${options.paths.length} path(s), ${(options.keywords ?? []).length} keyword(s)`));
  if (ghDegraded) {
    output.error(pc.yellow(`⚠ gh unavailable (${ghDegraded.split('\n')[0]}) — PR overlap NOT checked; spec scan only.`));
  }

  const total = openOverlaps.length + mergedOverlaps.length + specMatches.length;
  if (total === 0 && !ghDegraded) {
    output.write(pc.green('✓ No claims found — no open/recent PR touches these paths, no spec matches the keywords.'));
    return 0;
  }

  for (const { pr, overlap, bucket } of [...openOverlaps, ...mergedOverlaps]) {
    const tag = bucket === 'open' ? pc.yellow('[OPEN]') : pc.magenta('[MERGED]');
    output.write(`${tag} #${pr.number} ${pr.title} ${pc.dim(`(${pr.headRefName ?? '?'}, updated ${pr.updatedAt ?? '?'})`)}`);
    for (const f of overlap) output.write(`    ↳ ${f}`);
  }
  for (const m of specMatches) {
    output.write(`${pc.cyan('[SPEC]')} docs/specs/${m.file} ${pc.dim(`(matched: ${m.matched.join(', ')})`)}`);
  }
  if (total > 0) {
    output.write(pc.bold(
      `\n${total} potential claim(s). Before building: read them — if a sibling owns a layer, claim a DIFFERENT layer explicitly (division-of-labor beats a merge war).`,
    ));
  }
  return options.strict && total > 0 ? 1 : ghDegraded && options.strict ? 1 : 0;
}
