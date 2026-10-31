/**
 * Migration parity for the homebase BACKFILL: an existing agent's CLAUDE.md carries the first
 * card, which says there is no backfill. The migration replaces that card in place, once, and
 * leaves the following section untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { peerHomebaseAwareness, PEER_HOMEBASE_AWARENESS_V1_LIMITS, PEER_HOMEBASE_AWARENESS_V2_LIMITS, PEER_HOMEBASE_AWARENESS_ROUTING_MARKER } from '../../src/core/peerHomebaseAwareness.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const V1_CARD = `### Where a peer agent's notices go (per-peer homebase topic)

A mutually-verified peer agent **may have** a dedicated topic.

- **Honest limits, accepted deliberately** (spec section 6): topic identity rests on its name, a
  crash between creating a topic and recording its id can leave a duplicate, ${PEER_HOMEBASE_AWARENESS_V1_LIMITS} Carried
  by CMT-014.
`;

describe('PostUpdateMigrator — peer homebase card refresh', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-homebase-refresh-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-peerHomebaseRefresh.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('replaces the v1 card in place, keeps the next section, and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${V1_CARD}\n### Next section\nkeep me\n`);
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: refreshed per-peer homebase topic awareness (backfill)');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).not.toContain(PEER_HOMEBASE_AWARENESS_V1_LIMITS);
    expect(after).toContain(peerHomebaseAwareness());
    expect(after).toContain('### Next section\nkeep me');
    expect(after.split('per-peer homebase topic)').length - 1).toBe(1);

    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: refreshed per-peer homebase topic awareness (backfill)');
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(after);
  });

  it('replaces the v2 card (boot backfill only, retry at next start) in place', () => {
    const v2 = `### Where a peer agent's notices go (per-peer homebase topic)

A mutually-verified peer agent **may have** a dedicated topic named \`"🤝 <peer>"\`.

- **Honest limits, accepted deliberately** (spec section 6): topic identity rests on its name, a
  crash between creating a topic and recording its id can leave a duplicate, and ${PEER_HOMEBASE_AWARENESS_V2_LIMITS} Carried by CMT-014.
`;
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${v2}\n### Next section\nkeep me\n`);
    const r1 = run();
    expect(r1.upgraded).toContain('CLAUDE.md: refreshed per-peer homebase topic awareness (backfill)');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).not.toContain(PEER_HOMEBASE_AWARENESS_V2_LIMITS);
    expect(after).toContain(peerHomebaseAwareness());
    expect(after).toContain('### Next section\nkeep me');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: refreshed per-peer homebase topic awareness (backfill)');
  });

  it('replaces a card that predates the §2.6 routing rule (binding decides) in place, once', () => {
    const v3 = `### Where a peer agent's notices go (per-peer homebase topic)

A mutually-verified peer agent **may have** a dedicated topic named \`"🤝 <peer>"\`.

- **Which topic a peer message actually lands in** is decided by the conversation's binding
  first. The homebase is where an **unbound** conversation goes.
`;
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${v3}\n### Next section\nkeep me\n`);
    const r1 = run();
    expect(r1.upgraded).toContain('CLAUDE.md: updated per-peer homebase topic awareness (user-meant messages land in the homebase)');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(PEER_HOMEBASE_AWARENESS_ROUTING_MARKER);
    expect(after).not.toContain('is where an **unbound** conversation goes');
    expect(after).toContain('### Next section\nkeep me');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: updated per-peer homebase topic awareness (user-meant messages land in the homebase)');
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(after);
  });

  it('the current card carries the §2.6 routing marker', () => {
    expect(peerHomebaseAwareness()).toContain(PEER_HOMEBASE_AWARENESS_ROUTING_MARKER);
  });

  it('the current card describes the backfill and the default-on gate', () => {
    const card = peerHomebaseAwareness();
    expect(card).not.toContain(PEER_HOMEBASE_AWARENESS_V1_LIMITS);
    expect(card).not.toContain(PEER_HOMEBASE_AWARENESS_V2_LIMITS);
    expect(card).toMatch(/on its next message in either direction/);
    expect(card).toMatch(/On by default/);
  });
});
