import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('server-side GitHub runtime wiring', () => {
  it('keeps Throughput CLI-free and on direct authenticated GraphQL', () => {
    const source = read('src/server/throughputRoutes.ts');
    expect(source).toContain('fetchGitHubGraphql');
    expect(source).toContain('resolveGitHubToken');
    expect(source).not.toContain("from 'node:child_process'");
    expect(source).not.toMatch(/execFile\s*\(\s*['"]gh['"]/);
  });

  it('routes the Green-PR watcher and CI poller through the shared helper', () => {
    const green = read('src/monitoring/greenPrAutomergeWiring.ts');
    const ci = read('src/monitoring/CiFailurePoller.ts');
    expect(green).toContain('createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir })');
    expect(green).toContain('resolveRuntime: githubRuntime');
    expect(green).toContain('resolveGitHubEnv: () =>');
    expect(ci).toContain('createAuthenticatedGhSyncExec({');
    expect(ci).toContain('resolveRuntime: opts.githubRuntime');
    expect(green).not.toContain("execFile('gh'");
    expect(ci).not.toContain("execFileSync('gh'");
  });

  it('threads the per-agent state directory into both server constructors', () => {
    const server = read('src/server/AgentServer.ts');
    expect(server).toContain('createThroughputRoutes({ stateDir: options.config.stateDir })');
    expect(server).toMatch(/new CiFailurePoller\(\{\s*ledger: this\.failureLedger,\s*stateDir: options\.config\.stateDir,/);
  });
});
