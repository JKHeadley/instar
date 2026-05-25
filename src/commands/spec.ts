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

interface ConformanceFinding { standard: string; family: string; status: string; reason: string }
interface ConformanceResponse {
  report: { findings: ConformanceFinding[]; standardsChecked: number; degraded: boolean; degradeReason?: string };
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
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(pc.red(`Could not reach the instar server on port ${port}: ${(err as Error).message}`));
    console.error('Is the server running? Try: instar server start');
    process.exit(1);
  }

  if (!resp.ok) {
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
    console.log(pc.yellow(`\n  (report degraded: ${report.degradeReason ?? 'unknown'} — no findings produced; this is advisory, not authoritative)`));
    return;
  }
  if (report.findings.length === 0) {
    console.log(pc.green('\n  ✓ No possible standard-violations flagged.'));
    return;
  }
  console.log(pc.bold(`\n  ${report.findings.length} possible violation(s) flagged (signal — you decide):\n`));
  for (const f of report.findings) {
    console.log(`  ${pc.yellow('•')} ${pc.bold(f.standard)} ${pc.dim(`[${f.family}]`)}`);
    console.log(`    ${f.reason}`);
  }
  console.log('');
}
