import { openManagedCodexAppServer, type ManagedCodexAppServerOptions } from './ManagedCodexAppServer.js';
import {
  dispatchManagedCodexProject, type ManagedProjectAdmission, type ManagedProjectDispatchDependencies,
} from './ManagedCodexProjectDispatch.js';
import { createManagedCodexWorkerHome, readManagedCodexWorkerHome } from './ManagedCodexWorkerHome.js';

interface Dependencies extends Pick<ManagedProjectDispatchDependencies, 'enabled' | 'readAdmission' | 'store' | 'reserveWork'> {
  protectedStateDir: string;
  workspaceDir: string;
  /** The server resolves configuration and credentials for this exact new home. */
  prepare(
    admission: ManagedProjectAdmission, home: string,
  ): Promise<Omit<ManagedCodexAppServerOptions, 'cwd'> & { firstInput: string }>;
}

/** Bind the inert thread and private home durably before issuing its first input. */
export async function launchManagedCodexAppServer(workKey: string, deps: Dependencies) {
  let client: Awaited<ReturnType<typeof openManagedCodexAppServer>> | undefined;
  let firstInput: string | undefined;
  let startedTurnId: string | undefined;
  const launch = await dispatchManagedCodexProject(workKey, {
    enabled: deps.enabled, readAdmission: deps.readAdmission, store: deps.store, reserveWork: deps.reserveWork,
    launch: async (admission, launchId) => {
      const { home, homeIdentity } = createManagedCodexWorkerHome(deps.protectedStateDir, deps.workspaceDir, launchId);
      const { firstInput: input, ...options } = await deps.prepare(admission, home);
      firstInput = input;
      client = await openManagedCodexAppServer({
        ...options, cwd: deps.workspaceDir,
        env: { ...options.env, HOME: home, CODEX_HOME: home, INSTAR_SESSION_ID: launchId, INSTAR_MANAGED_CODEX_STOP: '1' },
      });
      return { launchId, nativeSessionId: client.nativeSessionId, homeIdentity };
    },
    verifyLaunch: (_admission, launch) => client?.isOpen() === true
      && client.nativeSessionId === launch.nativeSessionId && launch.homeIdentity !== undefined
      && readManagedCodexWorkerHome(deps.protectedStateDir, deps.workspaceDir, launch.launchId, launch.homeIdentity) !== undefined,
    releaseLaunch: async () => {
      if (!client || !firstInput) throw new Error('managed Codex first input is missing');
      startedTurnId = await client.startFirstTurn(firstInput);
    },
    cancelLaunch: async () => { await client?.close(); },
  });
  if (!launch || !client || !startedTurnId) return;
  return { ...launch, startedTurnId, close: client.close };
}
