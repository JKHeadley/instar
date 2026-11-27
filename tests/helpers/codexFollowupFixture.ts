import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import { createTempProject } from './setup.js';

/** Real state, SQLite journal and account transcript; only the terminal boundary is a fixture. */
export function codexFollowupFixture() {
  const project = createTempProject();
  const accountHome = path.join(project.dir, 'pooled-codex');
  const rollout = path.join(accountHome, 'sessions/2026/11/23/rollout-fixture-native-rollout.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, '{"type":"session_meta","payload":{"id":"native-rollout"}}\n');
  const envFile = path.join(project.dir, 'runtime-env');
  fs.writeFileSync(envFile, `CODEX_HOME=${accountHome}\n`);
  const tmux = path.join(project.dir, 'fixture-tmux');
  fs.writeFileSync(tmux, '#!/bin/sh\nif [ "$1" = show-environment ] && [ "$2" = -t ] && [ "$3" = =pooled-session ]; then\ncase "$4" in\nCODEX_HOME) value=$(cat "$(dirname "$0")/runtime-env"); case "$value" in\n!missing) echo "unknown variable: CODEX_HOME" >&2; exit 1 ;;\n!error) echo "server unavailable" >&2; exit 2 ;;\n*) printf "%s\\n" "$value" ;;\nesac ;;\nINSTAR_FRAMEWORK) echo INSTAR_FRAMEWORK=codex-cli ;;\n*) exit 2 ;;\nesac\nelse\nexit 2\nfi\n', { mode: 0o755 });
  const session = {
    id: 'pooled-session-id', name: 'pooled session', tmuxSession: 'pooled-session', status: 'running' as const,
    startedAt: new Date().toISOString(), framework: 'codex-cli' as const, claudeSessionId: 'native-rollout',
    model: 'gpt-6', maxDurationMinutes: 60, cwd: project.dir,
  };
  project.state.saveSession(session);
  const managers: SessionManager[] = [];
  function boot() {
    const manager = new SessionManager({
      tmuxPath: tmux, claudePath: '/usr/bin/echo', projectDir: project.dir,
      maxSessions: 2, protectedSessions: [], completionPatterns: [], framework: 'codex-cli',
    }, project.state, {
      stageBActivation: { configured: true, pendingActivation: false, active: true, reason: 'candidate-canary', artifactDigest: null },
    });
    managers.push(manager);
    const seam = manager as unknown as {
      codexRolloutPathForSession(s: typeof session): string | null;
      performTmuxInjectionEffect(...args: unknown[]): void;
      verifyInjection(...args: unknown[]): void;
      inboundDeliveries: InboundDeliveryStore;
      dispatchPreparedInboundDeliveries(): void;
    };
    const paste = vi.spyOn(seam, 'performTmuxInjectionEffect').mockImplementation(() => undefined);
    vi.spyOn(seam, 'verifyInjection').mockImplementation(() => undefined);
    return { manager, seam, paste, store: seam.inboundDeliveries };
  }
  return { project, accountHome, rollout, envFile, tmux, session, boot,
    cleanup() { for (const m of managers) { m.stopMonitoring(); (m as unknown as { inboundDeliveries: InboundDeliveryStore }).inboundDeliveries.close(); } project.cleanup(); },
  };
}
