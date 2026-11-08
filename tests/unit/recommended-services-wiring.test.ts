import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { RECOMMENDED_SERVICE_RECORD_KIND, RECOMMENDED_SERVICES_STORE_KEY } from '../../src/recommended/RecommendedServicesReplicatedStore.js';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');

describe('recommended services wiring', () => {
  it('the kind is a real journal kind, and the store is accounted for', () => {
    expect(JOURNAL_KINDS).toContain(RECOMMENDED_SERVICE_RECORD_KIND);
    expect(RECONCILER_ALLOWLIST[RECOMMENDED_SERVICES_STORE_KEY]).toBeTruthy();
  });

  it('the server registers, enables, ingests and passes the ledger', () => {
    const server = read('src/commands/server.ts');
    expect(server).toContain('replicatedKindRegistry.register(RECOMMENDED_SERVICES_KIND_REGISTRATION)');
    expect(server).toContain('recommendedServices: { enabled: true }');
    expect(server).toContain('!!coherenceJournal && _stateSyncStoresBase?.recommendedServices?.enabled !== false');
    expect(server).toContain('Rows written while the journal was off');
    expect(server).toContain('ledger.setReplicating(_stateSyncStoresResolved?.recommendedServices?.enabled === true && config.multiMachine?.coherenceJournal?.replication?.enabled === true)');
    expect(server).toContain("kind === 'recommended-service-record'");
    expect(server).toContain('recommendedServicesLedger: _recommendedServicesLedger');
    expect(server).toContain('importLegacyDeclines(_recommendedServicesLedger');
    expect(read('src/server/AgentServer.ts')).toContain('routeCtx.recommendedServicesLedger = options.recommendedServicesLedger');
  });

  it('the old offer paths refuse the retired ids', () => {
    expect(read('src/core/DiscoveryEvaluator.ts')).toContain('isRetiredLegacyOffer(definition.id)');
    expect(read('src/server/routes.ts')).toContain('OFFER_RETIRED');
  });

  it('the server gives the routes a real reach check, a strand check and a key remover', () => {
    const routes = read('src/server/routes.ts');
    expect(routes).toContain('canReachOwner: () => { try { return !!ctx.telegram && (ctx.coordinator?.enabled ? ctx.coordinator.holdsLease() : true); }');
    expect(routes).toContain("otherRouteWorks: async (service) => (service !== 'telegram' && !!ctx.telegram) || (service !== 'slack' && !!ctx.slack)");
    expect(routes).toContain('deleteSecret: (name) => { new SecretStore({ stateDir: ctx.config.stateDir, forceFileKey: ctx.config.secrets?.forceFileKey }).delete(name); }');
    // The Bitwarden recipe's copy and page list come from the real vault and the real CLI surface, names only.
    expect(routes).toContain('readSecretNames: () => copySourceNames(new SecretStore({ stateDir: ctx.config.stateDir, forceFileKey: ctx.config.secrets?.forceFileKey }).read(), ctx.config as unknown as Record<string, unknown>)');
    expect(routes).toContain("const held = name.startsWith('config.') ? configHeldSecrets(ctx.config as unknown as Record<string, unknown>)[name] : undefined;");
    expect(routes).toContain('bitwarden: realBitwardenSurface(');
    // The GitHub recipe's surface, the agent's name, the config switch a no turns off, and the attention item for a public repository.
    expect(routes).toContain('github: realGitHubBackupSurface(ctx.config.stateDir,');
    // The first list (Offers): the switch, the send to the owner's conversation with its message id, the link base, the taps.
    expect(routes).toContain('offersEnabled: () => !!ctx.config.recommendedServices?.offers?.enabled');
    expect(routes).toContain('ctx.telegram!.sendOfferList(topicId, text, buttons)');
    expect(routes).toContain('registerOfferTapHandler: (handler) => { ctx.telegram?.setRecommendedOfferHandler?.(handler); }');
    expect(routes).toContain('pickPrimaryLanIp(os.networkInterfaces()');
    // Voice transcription: the vault reader every transcription caller falls back to, registered once by the server.
    expect(routes).toContain('registerStoredTranscriptionKey(() => {');
    expect(routes).toContain('.get(VOICE_TRANSCRIPTION_SECRET)');
    expect(read('src/commands/server.ts')).toContain("(await import('../core/VoiceTranscription.js')).resolveTranscriptionProvider({ explicit, env: {} })");
    expect(read('src/messaging/backends/BaileysBackend.ts')).toContain('resolveSharedTranscriptionProvider({ env: {} })');
    const adapter = fs.readFileSync(path.join(root, 'src/messaging/TelegramAdapter.ts'), 'utf8');
    expect(adapter).toContain("if (query.data.startsWith('rs:'))");
    expect(adapter).toContain('this.recommendedOfferHandler({ action: m[1] === \'y\' ? \'yes\' : \'no\', nonce: m[2]!, fromIsOwner })');
    expect(routes).toContain("disableGitBackup: () => { writeConfigAtomic(path.join(ctx.config.stateDir, 'config.json'), (cfg) => { cfg.gitBackup = { ...((cfg.gitBackup as Record<string, unknown>) ?? {}), enabled: false }; return { value: true }; }); },");
    expect(routes).toContain('raiseAttention: async (id, title, text) => {');
  });

  it('a lone machine backs its choices up', () => {
    expect(read('src/core/BackupManager.ts')).toContain("'state/recommended-services/'");
  });
});
