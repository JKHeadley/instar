import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import { openManagedCodexAppServer } from '../../src/core/ManagedCodexAppServer.js';
import { launchManagedCodexAppServer } from '../../src/core/ManagedCodexAppServerLaunch.js';
import { openManagedCodexWorkDatabase } from '../../src/core/ManagedCodexWorkDatabase.js';
import { createManagedCodexWorkerHome } from '../../src/core/ManagedCodexWorkerHome.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { resolveCodexNativeCanaryBinary } from '../../src/messaging/telegram-origin/OriginCodexModelCanary.js';
import { CODEX_CANARY_MODELS, openCodexCanaryProvider } from '../../src/messaging/telegram-origin/OriginCodexModelCanaryProtocol.js';

const binary = process.platform === 'darwin'
  ? await resolveCodexNativeCanaryBinary('/usr/local/bin/codex')
    ?? await resolveCodexNativeCanaryBinary('/opt/homebrew/bin/codex')
  : null;

it.skipIf(!binary).each(['release', 'reject', 'disconnect'] as const)(
  'starts no implicit managed turn (%s)', async action => {
    const project = createTempProject();
    const workspace = path.join(project.dir, 'workspace');
    const stateDir = path.join(project.dir, 'state');
    fs.mkdirSync(workspace);
    fs.mkdirSync(stateDir);
    const work = openManagedCodexWorkDatabase(stateDir, true)!;
    const provider = await openCodexCanaryProvider(new AbortController().signal);
    let close: (() => Promise<void>) | undefined;
    const options = {
      binary: binary!, model: CODEX_CANARY_MODELS[0], modelProvider: 'fixture',
      sandbox: 'read-only' as const, timeoutMs: 10_000, env: { PATH: process.env.PATH },
    };
    function configure(home: string): void {
      fs.writeFileSync(path.join(home, 'config.toml'), [
        `model = "${CODEX_CANARY_MODELS[0]}"`, 'model_provider = "fixture"', 'approval_policy = "never"',
        'sandbox_mode = "read-only"', 'web_search = "disabled"',
        '[features]', 'shell_snapshot = false', '[analytics]', 'enabled = false',
        '[model_providers.fixture]', 'name = "Fixture"', `base_url = "http://127.0.0.1:${provider.port}/v1"`,
        'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
      ].join('\n'), { mode: 0o600 });
    }
    try {
      SafeGitExecutor.run(['init', '-q'], { cwd: workspace, operation: 'managed-app-server-launch-fixture' });
      if (action === 'disconnect') {
        const { home } = createManagedCodexWorkerHome(stateDir, workspace, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
        configure(home);
        const client = await openManagedCodexAppServer({
          ...options, cwd: workspace, env: { ...options.env, HOME: home, CODEX_HOME: home },
        });
        close = client.close;
        expect(client.nativeSessionId).toMatch(/[0-9a-z-]+/i);
        expect(provider.models).toHaveLength(0);
        await client.close();
        expect(provider.models).toHaveLength(0);
        expect(provider.failed()).toBe(false);
        return;
      }

      const admission = {
        workKey: 'approved-action', roundKey: 'round', revision: 'revision',
        topicId: '147616', machineId: 'local', ownerEpoch: 1, remaining: 2,
      };
      let stillAdmitted = true;
      const worker = await launchManagedCodexAppServer(admission.workKey, {
        enabled: () => true, store: work.store,
        readAdmission: () => stillAdmitted ? admission : undefined,
        reserveWork: (_admission, reserve) => reserve(),
        protectedStateDir: stateDir, workspaceDir: workspace,
        prepare: async (_admission, home) => {
          configure(home);
          expect(provider.models).toHaveLength(0);
          if (action === 'reject') stillAdmitted = false;
          return { ...options, firstInput: 'Return CANARY_OK without calling tools.' };
        },
      });
      if (action === 'release') {
        close = worker?.close;
        expect(worker?.startedTurnId).toMatch(/[0-9a-z-]+/i);
        expect(work.store.hasEnrollment(worker!.nativeSessionId)).toBe(true);
        await vi.waitFor(() => expect(provider.models).toEqual([CODEX_CANARY_MODELS[0]]));
      } else {
        expect(worker).toBeUndefined();
        expect(provider.models).toHaveLength(0);
      }
      expect(provider.failed()).toBe(false);
    } finally {
      await close?.();
      await provider.close();
      work.close();
      project.cleanup();
    }
  }, 40_000,
);
