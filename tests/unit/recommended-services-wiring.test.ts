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
    expect(routes).toContain('readSecretNames: () => copiedSecretNames(new SecretStore({ stateDir: ctx.config.stateDir, forceFileKey: ctx.config.secrets?.forceFileKey }).read())');
    expect(routes).toContain('bitwarden: realBitwardenSurface(');
  });

  it('a lone machine backs its choices up', () => {
    expect(read('src/core/BackupManager.ts')).toContain("'state/recommended-services/'");
  });
});
