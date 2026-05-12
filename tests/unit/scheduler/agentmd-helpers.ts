/**
 * Test helpers for the Phase 1a agentmd JobLoader path.
 *
 * Builds a synthetic agent state under a tmpdir with arbitrary
 * `jobs.json` + `schedule/` + `instar/` + `user/` trees so each test can
 * stand up exactly the layout it cares about.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

export interface SyntheticAgentLayout {
  /** Optional legacy jobs.json contents. */
  jobsJson?: unknown[];
  /** Per-slug manifests, keyed by filename (without .json). */
  manifests?: Record<string, unknown>;
  /** Markdown files under .instar/jobs/instar/, keyed by slug (no .md). */
  instarMd?: Record<string, string>;
  /** Markdown files under .instar/jobs/user/, keyed by slug (no .md). */
  userMd?: Record<string, string>;
  /** Extra raw files to drop into the tree, keyed by relative-to-stateDir path. */
  extras?: Record<string, string>;
}

export interface SyntheticAgent {
  /** Absolute path to the state directory (analog of .instar/). */
  stateDir: string;
  /** Absolute path to the legacy jobs.json (whether it exists or not). */
  jobsFile: string;
  /** Absolute path to .instar/jobs/. */
  jobsRoot: string;
  /** Absolute path to .instar/jobs/schedule/. */
  scheduleDir: string;
  /** Cleanup callback. */
  cleanup: () => void;
}

export function buildSyntheticAgent(layout: SyntheticAgentLayout): SyntheticAgent {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agentmd-'));
  const jobsRoot = path.join(stateDir, 'jobs');
  const scheduleDir = path.join(jobsRoot, 'schedule');
  const instarDir = path.join(jobsRoot, 'instar');
  const userDir = path.join(jobsRoot, 'user');
  const jobsFile = path.join(stateDir, 'jobs.json');

  fs.mkdirSync(jobsRoot, { recursive: true });

  if (layout.jobsJson !== undefined) {
    fs.writeFileSync(jobsFile, JSON.stringify(layout.jobsJson, null, 2));
  }

  if (layout.manifests) {
    fs.mkdirSync(scheduleDir, { recursive: true });
    for (const [slug, manifest] of Object.entries(layout.manifests)) {
      fs.writeFileSync(
        path.join(scheduleDir, `${slug}.json`),
        JSON.stringify(manifest, null, 2),
      );
    }
  }

  if (layout.instarMd) {
    fs.mkdirSync(instarDir, { recursive: true });
    for (const [slug, content] of Object.entries(layout.instarMd)) {
      fs.writeFileSync(path.join(instarDir, `${slug}.md`), content);
    }
  }

  if (layout.userMd) {
    fs.mkdirSync(userDir, { recursive: true });
    for (const [slug, content] of Object.entries(layout.userMd)) {
      fs.writeFileSync(path.join(userDir, `${slug}.md`), content);
    }
  }

  if (layout.extras) {
    for (const [rel, content] of Object.entries(layout.extras)) {
      const full = path.join(stateDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  return {
    stateDir,
    jobsFile,
    jobsRoot,
    scheduleDir,
    cleanup: () => {
      try {
        SafeFsExecutor.safeRmSync(stateDir, {
          recursive: true,
          force: true,
          operation: 'tests/unit/scheduler/agentmd-helpers.ts:cleanup',
        });
      } catch {
        // best-effort
      }
    },
  };
}

/** Build a minimally-valid per-slug manifest, overridable per test. */
export function mkManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'demo-job',
    origin: 'instar',
    schedule: '0 */6 * * *',
    priority: 'medium',
    model: 'haiku',
    expectedDurationMinutes: 1,
    enabled: true,
    execute: { type: 'agentmd' },
    ...overrides,
  };
}

/** Build a valid agentmd `.md` body, overridable per test. */
export function mkAgentMd(
  options: {
    frontmatter?: Record<string, unknown>;
    body?: string;
    rawFrontmatter?: string;
  } = {},
): string {
  const body = options.body ?? '# Demo Job\n\nDo the demo.\n';
  if (options.rawFrontmatter !== undefined) {
    return `---\n${options.rawFrontmatter}\n---\n${body}`;
  }
  const fm = options.frontmatter ?? {
    name: 'Demo Job',
    description: 'A demo agentmd job.',
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
