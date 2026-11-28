import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuthorityCensus } from '../../scripts/lib/state-authority-census.mjs';

const root = fileURLToPath(new URL('../../src/', import.meta.url));

function fixture() {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/state-coherence-registry.json'), 'utf8'));
  return { census: registry.authorityCensus, categories: new Map<string, unknown>(registry.entries.map(entry => [entry.category, entry])) };
}

describe('observe-mode authority census schema', () => {
  it('accepts the declared split and planned targets together', () => {
    const { census, categories } = fixture();
    const result = readAuthorityCensus(census, root, categories);
    expect(result.contracts).toEqual(['job-definition/agent', 'project-lifecycle/agent']);
    expect(census.contracts[0].liveStores).toHaveLength(2);
  });

  it('rejects another owner contract for the same kind and scope', () => {
    const { census, categories } = fixture();
    census.contracts.push({ ...census.contracts[0] });
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/duplicate authority contract/);
  });

  it('rejects an adapter that does not resolve to source', () => {
    const { census, categories } = fixture();
    census.stores[0].adapters.push('core/NotARealWriter.ts');
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/invalid authority store/);
  });

  it('rejects a planned owner absent from the target adapter census', () => {
    const { census, categories } = fixture();
    census.contracts[0].plannedOwner = 'core/InitiativeTracker.ts';
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/exclusively declared planned target/);
  });

  it('rejects a writable target reused as a projection', () => {
    const { census, categories } = fixture();
    census.contracts[1].projections = [census.contracts[0].plannedStore];
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/invalid projection edge/);
  });

  it('rejects a protected location claimed twice', () => {
    const { census, categories } = fixture();
    census.stores[1].locations.push(census.stores[0].locations[0]);
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/overlapping protected locations/);
  });
  it('rejects a second target presented only as a live store', () => {
    const { census, categories } = fixture();
    const other = {
      ...census.stores[1],
      id: 'alternate-canonical-job-manifest',
      locations: ['alternate-job-manifests/'],
    };
    census.stores.push(other);
    census.contracts[0].liveStores.push(other.id);
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/has no planned owner/);
  });

  it.each([
    'state/coherence-journal/01.chief-of-staff-record.jsonl',
    'state/coherence-journal/',
    'state/coherence-journal/01.*.jsonl',
  ])('rejects another store claiming the Chief of Staff journal through %s', location => {
    const { census, categories } = fixture();
    census.stores[1].locations.push(location);
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/overlapping protected locations/);
  });

  it('rejects nested protected directories in either declaration order', () => {
    const { census, categories } = fixture();
    census.stores[0].locations.push('jobs/');
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/overlapping protected locations/);
    census.stores.reverse();
    expect(() => readAuthorityCensus(census, root, categories)).toThrow(/overlapping protected locations/);
  });

});
