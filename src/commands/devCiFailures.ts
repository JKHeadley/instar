/**
 * `instar dev:ci-failures <pr>` — print the exact failing tests (file:line +
 * assertion) for a PR's CI run, via the GitHub **check-run annotations API**.
 *
 * Why this exists: in some environments `gh run view --log[-failed]` returns
 * zero bytes (no readable job logs), which makes a red CI run undiagnosable from
 * the terminal. The check-run *annotations* endpoint
 * (`/repos/:owner/:repo/check-runs/:id/annotations`) still returns the failing
 * `path:line` + the assertion message even when the log endpoint is empty. This
 * command wraps that workaround so a contributor (or an autonomous agent) gets
 * the precise failure instantly instead of re-discovering it mid-run.
 *
 * Read-only: it only calls `gh` GET endpoints; it never mutates anything.
 */
import { execFile } from 'node:child_process';
import pc from 'picocolors';

/** Shape of a GitHub check-run annotation (subset we use). */
export interface CiAnnotation {
  path?: string;
  start_line?: number;
  annotation_level?: string; // 'failure' | 'warning' | 'notice'
  message?: string;
}

export interface CiFailuresOutput {
  write(text: string): void;
  error(text: string): void;
}

/** Injectable `gh` boundary so the command is unit-testable without the network. */
export interface CiFailuresDeps {
  /** Run a `gh` invocation and return its parsed JSON stdout (or throw). */
  ghJson(args: string[]): Promise<unknown>;
}

export interface DevCiFailuresOptions {
  pr: string;
  repo?: string;
  output?: CiFailuresOutput;
  deps?: CiFailuresDeps;
}

const DEFAULT_REPO = 'JKHeadley/instar';
const MAX_MESSAGE_LINES = 6;

/**
 * Pure: turn a check-run's annotations into actionable failure lines, dropping
 * CI-infrastructure noise that isn't a test failure:
 *  - non-`failure` levels (warnings/notices, e.g. the Node-20 deprecation notice),
 *  - the workflow runner's own `.github/...` annotations,
 *  - the generic `Process completed with exit code N.` step-failure line.
 * Each kept entry is `path:line` + the (truncated) assertion message.
 */
export function extractFailureLines(annotations: CiAnnotation[]): string[] {
  const lines: string[] = [];
  for (const a of annotations) {
    if ((a.annotation_level ?? '') !== 'failure') continue;
    const path = a.path ?? '';
    if (path === '.github' || path.startsWith('.github/')) continue;
    const msg = (a.message ?? '').trim();
    if (!msg) continue;
    if (/^Process completed with exit code \d+\.?$/.test(msg)) continue;
    const loc = a.start_line ? `${path}:${a.start_line}` : path || '(no path)';
    const summary = msg.split('\n').slice(0, MAX_MESSAGE_LINES).join('\n');
    lines.push(`${loc}\n${summary}`);
  }
  return lines;
}

function defaultDeps(): CiFailuresDeps {
  return {
    ghJson: (args) =>
      new Promise((resolve, reject) => {
        execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error(`gh returned non-JSON: ${(e as Error).message}`));
          }
        });
      }),
  };
}

/**
 * Resolve the PR's head SHA, list its FAILED check-runs, and print each one's
 * test-level failure annotations. Returns 0 on success (even when failures are
 * found — this is a diagnostic, not a gate), 1 on an operational error
 * (PR unresolvable / API failure).
 */
export async function runDevCiFailures(opts: DevCiFailuresOptions): Promise<number> {
  const repo = opts.repo ?? DEFAULT_REPO;
  const out =
    opts.output ?? { write: (t: string) => void process.stdout.write(t), error: (t: string) => void process.stderr.write(t) };
  const deps = opts.deps ?? defaultDeps();

  // 1. Resolve the PR head SHA.
  let sha: string;
  try {
    const view = (await deps.ghJson(['pr', 'view', opts.pr, '--repo', repo, '--json', 'headRefOid'])) as {
      headRefOid?: string;
    };
    sha = view.headRefOid ?? '';
    if (!sha) throw new Error('no headRefOid on the PR');
  } catch (e) {
    out.error(`Could not resolve PR #${opts.pr} on ${repo}: ${(e as Error).message}\n`);
    return 1;
  }

  // 2. Failed check-runs for that head SHA.
  let failed: Array<{ id: number; name: string }>;
  try {
    const checks = (await deps.ghJson([
      'api',
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      '--paginate',
    ])) as { check_runs?: Array<{ id: number; name: string; conclusion: string }> };
    failed = (checks.check_runs ?? [])
      .filter((r) => r.conclusion === 'failure')
      .map((r) => ({ id: r.id, name: r.name }));
  } catch (e) {
    out.error(`Could not list check-runs for ${sha.slice(0, 9)}: ${(e as Error).message}\n`);
    return 1;
  }

  out.write(`${pc.bold(`PR #${opts.pr}`)} @ ${sha.slice(0, 9)} — ${failed.length} failed check(s)\n`);
  if (failed.length === 0) {
    out.write(pc.green('No failed checks.\n'));
    return 0;
  }

  // 3. Annotations per failed check → actionable failure lines (deduped across
  //    the node-20/node-22 shard pairs that report the identical failure).
  const seen = new Set<string>();
  let total = 0;
  for (const check of failed) {
    let annotations: CiAnnotation[] = [];
    try {
      annotations = ((await deps.ghJson(['api', `repos/${repo}/check-runs/${check.id}/annotations`])) as CiAnnotation[]) ?? [];
    } catch {
      continue; // annotations endpoint hiccup for one check — keep going
    }
    for (const line of extractFailureLines(annotations)) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.write(`\n${pc.red('✗')} ${line}\n`);
      total++;
    }
  }

  if (total === 0) {
    out.write(
      pc.yellow(
        '\nThe failed checks have no test-level annotations — likely a build/lint/type step.\n' +
          'Open the run in the browser, or check the step output directly.\n',
      ),
    );
  }
  return 0;
}
