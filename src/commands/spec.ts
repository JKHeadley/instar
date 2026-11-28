/**
 * `instar spec conformance <path>` — run the standards-conformance gate against
 * a draft spec from the command line.
 *
 * Thin client over the local server's POST /spec/conformance-check: the server
 * already has the subscription-backed intelligence provider wired, so the CLI
 * just reads the spec, posts it, and prints the rule-by-rule report. Signal-only
 * — it advises; it never blocks. Spec: docs/specs/standards-conformance-gate.md
 * (tracked deferral `scg-cli`).
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

export interface SpecConformanceOptions {
  /** Path to the spec markdown file. */
  specPath: string;
  /** Project dir (for loadConfig). */
  dir?: string;
  /** Server port override. */
  port?: number;
  /** Emit raw JSON instead of the formatted report. */
  json?: boolean;
}

/** Client wait for the check: above the route's 180 s request budget. */
export const CLI_CONFORMANCE_TIMEOUT_MS = 200_000;

/** The reasons already say "not checked:"; the CLI's own label says it once. */
const reasonOnly = (s: string | undefined) => (s ?? '').replace(/^not checked:\s*/i, '');

interface ConformanceFinding { standard: string; family: string; status: string; reason: string }
interface ConformanceResponse {
  report: {
    findings: ConformanceFinding[]; standardsChecked: number; degraded: boolean; degradeReason?: string; notCheckedReason?: string;
    fit?: { verdict: string; reason?: string; degraded?: boolean };
  };
  registryCanary: { ok: boolean; articleCount: number; failures: string[] };
}

export async function runSpecConformance(opts: SpecConformanceOptions): Promise<void> {
  const abs = path.resolve(opts.specPath);
  if (!fs.existsSync(abs)) {
    console.error(pc.red(`Spec not found: ${abs}`));
    process.exit(1);
  }
  const markdown = fs.readFileSync(abs, 'utf-8');

  // Resolve port + auth from config (falls back to a sane default).
  let port = opts.port ?? 4040;
  let authToken: string | undefined;
  try {
    const { loadConfig } = await import('../core/Config.js');
    const config = loadConfig(opts.dir);
    if (!opts.port && typeof config.port === 'number') port = config.port;
    authToken = config.authToken;
  } catch { /* project may not be initialized — proceed with defaults */ }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  let resp: Response;
  try {
    resp = await fetch(`http://localhost:${port}/spec/conformance-check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ markdown }),
      // Longer than the route's own 180 s budget, so the server's stated answer arrives.
      signal: AbortSignal.timeout(CLI_CONFORMANCE_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      // The server was reached but did not answer in time: the spec was not checked.
      console.error(pc.red(`✗ NOT CHECKED: the check did not finish within ${CLI_CONFORMANCE_TIMEOUT_MS / 1000} s`));
      process.exitCode = 2;
      return;
    }
    console.error(pc.red(`Could not reach the instar server on port ${port}: ${e.message}`));
    console.error('Is the server running? Try: instar server start');
    process.exit(1);
  }

  if (!resp.ok) {
    if (resp.status === 408 || resp.status === 413) {
      // A timed-out or refused-as-too-large check is a stated not-checked result.
      console.error(pc.red(`✗ NOT CHECKED: ${resp.status === 408 ? 'the check ran out of time on the server' : 'the spec is over the input ceiling'}`));
      process.exitCode = 2;
      return;
    }
    if (resp.status === 503) {
      console.error(pc.yellow('The standards-conformance gate is disabled or the constitution is unreadable on this host.'));
    } else {
      console.error(pc.red(`Conformance check failed: ${resp.status} ${resp.statusText}`));
    }
    process.exit(1);
  }

  const data = await resp.json() as ConformanceResponse;

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    // Not checked exits 2 in both modes, so a script reading JSON cannot treat it as success.
    if (data.report?.degraded || data.report?.fit?.degraded) process.exitCode = 2;
    return;
  }

  // Formatted report.
  const { report, registryCanary } = data;
  console.log(pc.bold(`\nStandards conformance — ${path.basename(abs)}`));
  console.log(pc.dim(`Checked against ${report.standardsChecked} standards · registry canary: ${registryCanary.ok ? pc.green('ok') : pc.red('FAILED')}`));
  if (!registryCanary.ok) {
    console.log(pc.red(`  ⚠ registry canary failures: ${registryCanary.failures.join('; ')}`));
  }
  if (report.degraded) {
    // Not checked is not clean: say so loudly and exit non-zero, so a script that
    // chains on this command cannot read an unchecked spec as a passing one.
    console.log(pc.red(`\n  ✗ NOT CHECKED: ${reasonOnly(report.notCheckedReason) || report.degradeReason || 'unknown reason'}`));
    console.log(pc.yellow('  The empty findings list means nothing; do not report this spec as clean.'));
    process.exitCode = 2;
    return;
  }
  // The fit judgment counts the same: a spec naming a parent principle whose fit
  // could not be judged was not fully checked.
  const fitNotChecked = report.fit?.degraded === true;
  if (fitNotChecked) {
    console.log(pc.red(`\n  ✗ NOT CHECKED (fit): ${reasonOnly(report.fit?.reason) || 'the fit judgment did not run'}`));
    process.exitCode = 2;
  }
  if (report.findings.length === 0) {
    // Not shown as a clean pass when the fit judgment did not run.
    console.log(fitNotChecked ? pc.dim('\n  No possible standard-violations flagged by the review (the fit was not checked).') : pc.green('\n  ✓ No possible standard-violations flagged.'));
    return;
  }
  console.log(pc.bold(`\n  ${report.findings.length} possible violation(s) flagged (signal — you decide):\n`));
  for (const f of report.findings) {
    console.log(`  ${pc.yellow('•')} ${pc.bold(f.standard)} ${pc.dim(`[${f.family}]`)}`);
    console.log(`    ${f.reason}`);
  }
  console.log('');
}
