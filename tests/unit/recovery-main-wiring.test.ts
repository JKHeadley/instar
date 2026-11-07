import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoveryDirectHost, recoveryPairedPeers, startRecoveryMainWiring, type RecoveryMainWiringDeps } from '../../src/commands/recoveryMainWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const globals = globalThis as unknown as { __instarRecoveryRuntime?: { stop: () => void }; __instarRecoverySetup?: unknown };
const SELF = 'm_self', PEER = 'm_peer';
const row = (machineId: string, pairedAt: string) => ({ machineId, entry: { pairedAt, name: machineId, nickname: machineId } });
const identity = (rows: ReturnType<typeof row>[]) => ({
  getActiveMachines: () => rows, getSigningPublicKeyPem: (id: string) => (id === PEER ? 'peer-key' : null),
}) as unknown as RecoveryMainWiringDeps['identity'];

let dir = '';
afterEach(() => {
  globals.__instarRecoveryRuntime?.stop();
  delete globals.__instarRecoveryRuntime;
  delete globals.__instarRecoverySetup;
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:recovery-main-wiring:cleanup' });
  dir = '';
});

describe('recoveryPairedPeers', () => {
  it('uses the later of the two membership epochs, so both sides agree', () => {
    const early = '2026-01-01T00:00:00.000Z', late = '2026-06-01T00:00:00.000Z';
    expect(recoveryPairedPeers(identity([row(SELF, early), row(PEER, late)]), SELF))
      .toEqual([{ machineId: PEER, pairingEpoch: Date.parse(late), publicKey: 'peer-key' }]);
    expect(recoveryPairedPeers(identity([row(SELF, late), row(PEER, early)]), SELF)[0].pairingEpoch).toBe(Date.parse(late));
  });
  it('offers no peers when this machine is not a member or has no valid epoch', () => {
    expect(recoveryPairedPeers(identity([row(PEER, '2026-01-01T00:00:00.000Z')]), SELF)).toEqual([]);
    expect(recoveryPairedPeers(identity([row(SELF, 'not-a-date'), row(PEER, '2026-01-01T00:00:00.000Z')]), SELF)).toEqual([]);
  });
});

describe('recoveryDirectHost', () => {
  const at = (...urls: string[]) => urls.map(url => ({ url })) as never;
  it('picks the first private or Tailscale address', () => {
    expect(recoveryDirectHost(at('https://example.com:1', 'http://100.108.56.41:4062', 'http://10.0.0.2:1'))).toBe('100.108.56.41');
    expect(recoveryDirectHost(at('http://172.20.0.1:1'))).toBe('172.20.0.1');
  });
  it('returns empty for public, near-private or malformed addresses', () => {
    expect(recoveryDirectHost(at('not a url', 'https://example.com:1', 'http://172.32.0.1:1'))).toBe('');
  });
});

describe('startRecoveryMainWiring', () => {
  it('leaves a real, disabled runtime and setup reachable when the feature is off', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-main-wiring-'));
    const send = vi.fn(), get = vi.fn(() => undefined), set = vi.fn();
    const runtime = await startRecoveryMainWiring({
      config: { stateDir: dir, projectName: 'wiring-fixture', port: 0, multiMachine: { serverDownRecovery: { enabled: false } } } as never,
      liveConfig: { set: vi.fn() } as never,
      state: { get, set } as never,
      coordinator: { isRouter: () => false, getLeaseEpoch: () => 1 } as never,
      identity: identity([row(SELF, '2026-01-01T00:00:00.000Z')]),
      meshClient: { send } as never,
      peerUrl: () => null,
      machineId: SELF,
      machineSigningKey: 'key',
      selfEndpoints: [],
      telegramOriginBoot: () => undefined,
    });
    expect(globals.__instarRecoveryRuntime).toBe(runtime);
    expect(globals.__instarRecoverySetup).toBeDefined();
    expect(runtime.status()).toMatchObject({ scope: 'source-machine', sourceMachineId: SELF, enabled: false, ready: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('is what the server starts, with the guard still registered there', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(server).toContain('await startRecoveryMainWiring({');
    expect(server).toContain("guardRegistry.register('multiMachine.serverDownRecovery.enabled'");
    expect(server).not.toContain('new RecoverySetupRuntime(');
  });
});

describe('recovery runtime boundary', () => {
  // prepareRecoveryRuntimeSlot walks every module in dist/recovery and copies what
  // they import. Anything imported at runtime from outside recovery and core lands
  // in the runtime that must outlive the main package.
  it('keeps src/recovery runtime imports inside recovery and core', () => {
    const root = path.join(process.cwd(), 'src/recovery');
    const escaping = fs.readdirSync(root).filter(name => name.endsWith('.ts')).flatMap(name => {
      // Compile first so type-only imports are erased exactly as in dist, then let
      // the compiler list every remaining import, whatever its form.
      const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, name), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      });
      return ts.preProcessFile(outputText, true, true).importedFiles.map(file => file.fileName)
        .filter(specifier => specifier.startsWith('.'))
        .filter(specifier => !/^src\/(recovery|core)\//.test(path.posix.join('src/recovery', specifier)))
        .map(specifier => `${name} -> ${specifier}`);
    });
    expect(escaping).toEqual([]);
  });
});
