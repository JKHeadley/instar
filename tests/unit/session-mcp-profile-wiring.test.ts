/**
 * Wiring-integrity guard for MCP lever-1 (per-session profiles). The pure resolver
 * is useless if SessionManager never calls it — the "shipped inert" failure mode
 * (see rate-limit-recovery-wiring.test.ts). This asserts SessionManager actually
 * wires the profile flags into the INTERACTIVE claude-code spawn, on the
 * deterministic default-no-op path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/core/SessionManager.ts'), 'utf-8');

describe('MCP lever-1 — wiring integrity', () => {
  it('imports the pure resolver/filter from sessionMcpProfile', () => {
    expect(SRC).toContain("from './sessionMcpProfile.js'");
    expect(SRC).toContain('resolveMcpProfileServers');
    expect(SRC).toContain('filterMcpConfig');
  });

  it('defines the buildSessionMcpProfileFlags method that reads the topic profile + writes a filtered config', () => {
    expect(SRC).toMatch(/private buildSessionMcpProfileFlags\(topicId/);
    expect(SRC).toContain('resolveMcpProfileServers(topicId, this.config.mcpProfiles)');
    expect(SRC).toContain("'--strict-mcp-config', '--mcp-config'");
  });

  it('calls the builder in the INTERACTIVE claude-code spawn, gated on framework + with the topic id', () => {
    // The call must be inside the claude-code branch of spawnInteractiveSession,
    // using the topic id already in scope (telegramTopicId), pushing onto launchSpec.
    expect(SRC).toMatch(/this\.buildSessionMcpProfileFlags\(options\?\.telegramTopicId\)/);
    expect(SRC).toMatch(/launchSpec\.argv\.push\(\.\.\.mcpProfileFlags\)/);
  });

  it('fail-safe: the method returns [] (full .mcp.json) on the default/no-profile/error paths', () => {
    // resolveMcpProfileServers returns null ⇒ early [] ; a try/catch wraps the I/O.
    expect(SRC).toMatch(/if \(servers === null\) return \[\]/);
  });
});
