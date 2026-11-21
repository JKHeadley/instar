/**
 * messages-reach-renamed-sessions §D (PR-B) — production wiring is alive.
 * The server passes real guarded relay addresses (read at call time, after the mesh
 * block), starts the relay queue and boot recovery after the server is up, routes
 * dead letters through reportTerminalFailure, and keeps origin copies open for a late
 * notice. The relay route answers on both paths; the stale bearer exemption is gone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const server = read('src/commands/server.ts');
const routerBlock = server.slice(server.indexOf('const messageRouter = new MessageRouter('), server.indexOf('}, crossMachineDeps);'));
const retryBlock = server.slice(server.indexOf('const retryManager = new DeliveryRetryManager('), server.indexOf('retryManager.start();'));

describe('cross-machine relay wiring', () => {
  it('the router gets guarded addresses from the mesh resolver, read at call time', () => {
    expect(routerBlock).toMatch(/peerAddresses: \(machineId: string\) => \{/);
    expect(routerBlock).toMatch(/_resolvePeerUrls\?\.\(\) \?\? \[\]/);
    expect(routerBlock).toMatch(/isPeerUrlAllowedForCredentials\(\{ url: r\.url, kind: r\.kind \}, allow\)\.ok/);
  });

  it('the relay queue and boot recovery start after the server is up', () => {
    const after = server.slice(server.indexOf('await server.start();'));
    expect(after).toMatch(/messageRouter\.startRelayQueue\(\)\.then\(\(\) => messageRouter\.recoverPendingRelayed\(\)\)/);
  });

  it('dead letters go through reportTerminalFailure and origin copies wait for a late notice', () => {
    expect(retryBlock).toMatch(/onDeadLetter: \(envelope, reason\) => \{ messageRouter\.reportTerminalFailure\(envelope, reason\); \}/);
    expect(retryBlock).toMatch(/holdForRemoteNotice: \(envelope\) =>/);
  });

  it('the relay route serves both paths with signed answers; the bearer exemption is removed', () => {
    const routes = read('src/server/machineRoutes.ts');
    expect(routes).toMatch(/router\.post\(RELAY_MACHINE_PATH, authMiddleware, relayMachineHandler\);/);
    expect(routes).toMatch(/router\.post\(RELAY_MACHINE_LEGACY_PATH, authMiddleware, relayMachineHandler\);/);
    expect(routes).toMatch(/signRelayAnswer\(a, ctx\.localSigningKeyPem\)/);
    const mw = read('src/server/middleware.ts');
    expect(mw).not.toMatch(/req\.path === '\/messages\/relay-machine'/);
  });

  it('the sender posts to the shared path constant', () => {
    expect(read('src/messaging/CrossMachineRelayQueue.ts')).toMatch(/\$\{RELAY_MACHINE_PATH\}/);
    expect(read('src/messaging/MessageRouter.ts')).not.toMatch(/\/messages\/relay-machine`/);
  });
});
