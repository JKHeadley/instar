/**
 * "Connecting to another agent" — agent knowledge for the pairing-by-invite flow
 * (docs/specs/a2a-pairing-invite-link.md §3).
 *
 * Why: a brand-new agent asked its person for the other agent's "Threadline
 * fingerprint" and offered to "package a bundle" instead of offering an invite
 * (Justin, topic 61599, 2026-10-20). The invite flow existed; the agent's
 * knowledge framed it only around sharing credentials.
 *
 * Covers: the template carries the key instructions (Agent Awareness), the
 * migration delivers the SAME section to an existing agent exactly once
 * (Migration Parity), the self-knowledge tree serves it, and triage routes a
 * "connect with X" question to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { AGENT_CONNECT_HEADING, agentConnectSection, generateClaudeMd, AGENT_CONNECT_HOWTO_BULLET, THREADLINE_PAIR_TOOL_BULLET } from '../../src/scaffold/templates.js';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { TreeTraversal } from '../../src/knowledge/TreeTraversal.js';
import { TreeTriage } from '../../src/knowledge/TreeTriage.js';
import { ProbeRegistry } from '../../src/knowledge/ProbeRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test' });
}
function runClaudeMd(projectDir: string): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator(projectDir) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
function runTree(projectDir: string): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator(projectDir) as unknown as { migrateSelfKnowledgeTree(r: MigrationResult): void }).migrateSelfKnowledgeTree(r);
  return r;
}
const count = (s: string, sub: string) => s.split(sub).length - 1;
// The Threadline "How to Use" → "MCP Tools Available" stretch, where the section and both
// bullets live. migrateClaudeMd runs many other migrations over the whole file, so parity
// is asserted on this region rather than on the whole file.
const threadlineRegion = (md: string) => {
  const start = md.indexOf('### How to Use\n\nYou can ask me conversationally:');
  const end = md.indexOf('### One identity across my machines (agent identity)', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return md.slice(start, end);
};

// What an agent scaffolded before this change has: the Threadline section with
// its tools list, and no "Connecting to another agent".
const OLD_THREADLINE = `# CLAUDE.md — test

## Threadline Network (Agent-to-Agent Communication)

### How to Use

- "Connect to the agent network" → I'll enable the relay

### MCP Tools Available

- \`threadline_send\` — Send a message to another agent

### One identity across my machines (agent identity)

I am ONE agent.
`;

describe('Connecting to another agent: the instruction itself', () => {
  const section = agentConnectSection(4042);

  it('tells the agent to OFFER an invite, with the real tool and route', () => {
    expect(section.startsWith(AGENT_CONNECT_HEADING + '\n')).toBe(true);
    expect(section).toContain('I OFFER AN INVITE');
    expect(section).toContain('`threadline_pair` with `action: "invite"`');
    expect(section).toContain('POST /threadline/pairing/invites');
  });

  it('never asks the person for a fingerprint, settings or a bundle', () => {
    expect(section).toContain('I never ask my person for a fingerprint');
    expect(section).toContain('I never ask them to edit settings');
    expect(section).toMatch(/never offer a "bundle"/);
    expect(section).toContain('If I need the other agent\'s fingerprint, I look it up myself.');
  });

  it('says a PERSON carries the invite, outside the agent network, never over Threadline', () => {
    expect(section).toContain('A person carries the invite, outside the agent network.');
    expect(section).toContain('I never send it over Threadline');
    expect(section).toContain('Send this privately to Echo\'s person');
    expect(section).toContain('forward it to Echo\'s Telegram chat');
  });

  it('explains Approve (their person), Finish (mine) and how to check status', () => {
    expect(section).toContain('tap **Approve**');
    expect(section).toContain('**Finish pairing**');
    expect(section).toContain('No agent can approve for a person');
    expect(section).toContain('http://localhost:4042/threadline/pairing');
    expect(section).toContain('`mutual-verified`');
    expect(section).toContain('GET /threadline/pairing/invites');
  });

  it('when pairing is switched off, the agent switches it on itself (the exact keys)', () => {
    expect(section).toContain('`threadline.relayEnabled` and `threadline.verifiedPairing.enabled`');
    expect(section).toContain('I switch both on myself');
  });

  it('reads the expiry from the invite response and says it in local time (never a fixed "an hour")', () => {
    expect(section).not.toContain('expires in an hour');
    expect(section).toContain('It works once and expires at <time>.');
    expect(section).toContain('`exp` is when it stops working');
    expect(section).toContain("in my person's local time");
  });

  it('when another machine holds the relay, moves the conversation there with the real lever', () => {
    expect(section).toContain('does not run (or hold) the Threadline relay');
    expect(section).toContain('`GET /pool/placement?topic=<this topic>`');
    expect(section).toContain('`leaseHolderNickname`');
    expect(section).toContain('`POST /pool/transfer` and `{"topic": <this topic>, "to": "<that nickname>"}`');
    expect(section).toContain('`needsConfirmation`');
    expect(section).toContain('I tell my person which machine holds the relay, by name whenever I have it');
    expect(section).not.toContain('the invite is made there');
  });

  it('uses the port it is given', () => {
    expect(agentConnectSection(5555)).toContain('http://localhost:5555/threadline/pairing');
  });
});

describe('Connecting to another agent: new agents (template)', () => {
  it('appears once, inside the Threadline section, before the MCP tools list', () => {
    const md = generateClaudeMd('test', 'Test', 4042, true);
    expect(count(md, AGENT_CONNECT_HEADING)).toBe(1);
    expect(md).toContain(agentConnectSection(4042) + '\n### MCP Tools Available\n');
    const threadlineIdx = md.indexOf('## Threadline Network (Agent-to-Agent Communication)');
    expect(threadlineIdx).toBeGreaterThan(-1);
    expect(md.indexOf(AGENT_CONNECT_HEADING)).toBeGreaterThan(threadlineIdx);
  });

  it('lists threadline_pair among the Threadline tools and maps "connect with X" to an invite', () => {
    const md = generateClaudeMd('test', 'Test', 4042, true);
    expect(md).toContain('- `threadline_pair` — Pair with another agent');
    expect(md).toContain('"Connect with Echo" / "talk to <an agent>" / "pair with <an agent>" → I make a pairing invite');
  });
});

describe('Connecting to another agent: existing agents (migration)', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-connect-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/agent-connect-knowledge.test.ts:cleanup' }));

  it('delivers the same section once, before the Threadline tools list; a second run changes nothing', () => {
    fs.writeFileSync(claudeMd, OLD_THREADLINE);
    const r1 = runClaudeMd(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added "Connecting to another agent" (pairing by invite)');
    expect(count(once, AGENT_CONNECT_HEADING)).toBe(1);
    // Byte-identical to what a new agent gets, in the same place.
    expect(once).toContain(agentConnectSection(4042) + '\n### MCP Tools Available\n');
    // Nothing the agent already had is lost.
    expect(once).toContain('### One identity across my machines (agent identity)\n\nI am ONE agent.');

    const r2 = runClaudeMd(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: "Connecting to another agent" already present');
  });

  it('an agent scaffolded before this change ends up byte-identical to a new agent (section + both bullets)', () => {
    const fresh = generateClaudeMd('test', 'Test', 4042, true);
    // The pre-change template: no section, no threadline_pair bullet, no "Connect with Echo" bullet.
    const old = fresh
      .replace(agentConnectSection(4042) + '\n', '')
      .replace(THREADLINE_PAIR_TOOL_BULLET + '\n', '')
      .replace(AGENT_CONNECT_HOWTO_BULLET + '\n', '');
    expect(old).not.toContain(AGENT_CONNECT_HEADING);
    expect(old).not.toContain(THREADLINE_PAIR_TOOL_BULLET);
    expect(old).not.toContain(AGENT_CONNECT_HOWTO_BULLET);
    fs.writeFileSync(claudeMd, old);
    const r1 = runClaudeMd(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added threadline_pair to the Threadline tools list');
    expect(r1.upgraded).toContain('CLAUDE.md: added "Connect with <agent>" to Threadline How to Use');
    const once = fs.readFileSync(claudeMd, 'utf8');
    // Byte-identical to what a new agent gets, in the same places.
    expect(threadlineRegion(once)).toBe(threadlineRegion(fresh));
    expect(count(once, THREADLINE_PAIR_TOOL_BULLET)).toBe(1);
    expect(count(once, AGENT_CONNECT_HOWTO_BULLET)).toBe(1);

    const r2 = runClaudeMd(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: threadline_pair tool bullet already present');
    expect(r2.skipped).toContain('CLAUDE.md: "Connect with <agent>" How to Use bullet already present');
  });

  it('puts each bullet at the end of its own Threadline list in a minimal old file', () => {
    fs.writeFileSync(claudeMd, OLD_THREADLINE);
    runClaudeMd(projectDir);
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(count(md, THREADLINE_PAIR_TOOL_BULLET)).toBe(1);
    expect(count(md, AGENT_CONNECT_HOWTO_BULLET)).toBe(1);
    expect(md).toContain('- "Connect to the agent network" → I\'ll enable the relay\n' + AGENT_CONNECT_HOWTO_BULLET + '\n\n');
    expect(md).toContain('- `threadline_send` — Send a message to another agent\n' + THREADLINE_PAIR_TOOL_BULLET + '\n\n### One identity');
  });

  it('a file that already has both bullets (but not the section) keeps them once, unchanged in place', () => {
    const withBullets = OLD_THREADLINE
      .replace("I'll enable the relay\n", "I'll enable the relay\n" + AGENT_CONNECT_HOWTO_BULLET + '\n')
      .replace('another agent\n', 'another agent\n' + THREADLINE_PAIR_TOOL_BULLET + '\n');
    fs.writeFileSync(claudeMd, withBullets);
    const r = runClaudeMd(projectDir);
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(r.skipped).toContain('CLAUDE.md: threadline_pair tool bullet already present');
    expect(r.skipped).toContain('CLAUDE.md: "Connect with <agent>" How to Use bullet already present');
    expect(count(md, THREADLINE_PAIR_TOOL_BULLET)).toBe(1);
    expect(count(md, AGENT_CONNECT_HOWTO_BULLET)).toBe(1);
    // Only the section was added; the bullets were left where they were.
    const upTo = (t: string) => t.slice(0, t.indexOf('### One identity across my machines'));
    expect(upTo(md)).toBe(upTo(withBullets.replace('### MCP Tools Available\n', agentConnectSection(4042) + '\n### MCP Tools Available\n')));
  });

  it('appends the whole section when the agent has no Threadline tools heading', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md — test\n\nSome custom file.\n');
    runClaudeMd(projectDir);
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(count(md, AGENT_CONNECT_HEADING)).toBe(1);
    expect(md).toContain('Some custom file.\n');
    // Appended whole (later migrations may append after it).
    expect(md).toContain('\n' + agentConnectSection(4042));
    // With neither Threadline list present, both bullets sit just before the section, once.
    expect(md).toContain(THREADLINE_PAIR_TOOL_BULLET + '\n\n' + AGENT_CONNECT_HOWTO_BULLET + '\n\n' + AGENT_CONNECT_HEADING);
    const again = (runClaudeMd(projectDir), fs.readFileSync(claudeMd, 'utf8'));
    expect(again).toBe(md);
  });

  it('a freshly scaffolded agent is left alone (already has it)', () => {
    const fresh = generateClaudeMd('test', 'Test', 4042, true);
    fs.writeFileSync(claudeMd, fresh);
    const r = runClaudeMd(projectDir);
    expect(r.skipped).toContain('CLAUDE.md: "Connecting to another agent" already present');
    expect(r.skipped).toContain('CLAUDE.md: threadline_pair tool bullet already present');
    expect(r.skipped).toContain('CLAUDE.md: "Connect with <agent>" How to Use bullet already present');
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(threadlineRegion(md)).toBe(threadlineRegion(fresh));
    expect(count(md, AGENT_CONNECT_HEADING)).toBe(1);
    expect(count(md, THREADLINE_PAIR_TOOL_BULLET)).toBe(1);
    expect(count(md, AGENT_CONNECT_HOWTO_BULLET)).toBe(1);
  });
});

describe('Connecting to another agent: self-knowledge tree', () => {
  let projectDir: string; let stateDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-connect-tree-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/agent-connect-knowledge.test.ts:tree-cleanup' }));

  it('an existing tree without the node gets it on update, and it serves the CLAUDE.md section', async () => {
    // An existing agent's tree from before this change: generate, then strip the node.
    const gen = new TreeGenerator();
    const before = gen.generate({ projectDir, stateDir, agentName: 'test', hasMemory: true, hasJobs: true, hasDecisionJournal: true });
    for (const layer of before.layers) layer.children = layer.children.filter((n) => n.id !== 'capabilities.agent_connect');
    gen.save(before, stateDir);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'self-knowledge-tree.json'), 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('capabilities.agent_connect');

    const r = runTree(projectDir);
    expect(r.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'self-knowledge-tree.json'), 'utf8'));
    const caps = after.layers.find((l: { id: string }) => l.id === 'capabilities');
    const node = caps.children.find((n: { id: string }) => n.id === 'capabilities.agent_connect');
    expect(node).toBeDefined();
    expect(node.managed).toBe(true);
    expect(node.description).toContain('OFFER AN INVITE');
    expect(node.description).toContain('Never ask for a fingerprint');

    // The node's source reads the section out of the agent's CLAUDE.md.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), generateClaudeMd('test', 'Test', 4042, true));
    const traversal = new TreeTraversal({ projectDir, stateDir, probeRegistry: new ProbeRegistry() });
    const { fragments, errors } = await traversal.gather([node], { capabilities: 1 });
    expect(errors).toEqual([]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toContain('I OFFER AN INVITE');
    expect(fragments[0].content).toContain('**Finish pairing**');
    // The section stops at the next heading, not the rest of the file.
    expect(fragments[0].content).not.toContain('### MCP Tools Available');
  });

  it('triage routes "connect with Echo" to the node', async () => {
    const gen = new TreeGenerator();
    const tree = gen.generate({ projectDir, stateDir, agentName: 'test', hasMemory: true, hasJobs: true, hasDecisionJournal: true });
    const triage = new TreeTriage(null);
    for (const q of ['can you connect with Echo?', 'please pair with Scout', 'here is the tlinv1 code']) {
      const result = await triage.triage(q, tree.layers);
      expect(result.nodeScores?.['capabilities.agent_connect'] ?? 0, q).toBeGreaterThan(0);
    }
  });

  it('"fingerprint" is not an agent_connect routing keyword (it belongs to canonical_identity)', async () => {
    // Bare nodes (no name/description words) so only NODE_KEYWORDS can score them.
    const bare = (id: string) => ({ id, name: 'x', alwaysInclude: false, managed: true, depth: 'medium' as const, maxTokens: 100, sensitivity: 'public' as const, sources: [] });
    const layers = [{ id: 'capabilities', name: 'Capabilities', description: '', children: [bare('capabilities.agent_connect'), bare('capabilities.canonical_identity')] }];
    const triage = new TreeTriage(null);
    // Two canonical_identity keywords, so its layer clears the triage threshold and any
    // agent_connect keyword hit would show up as a non-zero score.
    const fp = await triage.triage('what is my ed25519 fingerprint', layers);
    expect(fp.nodeScores?.['capabilities.agent_connect'] ?? 0).toBe(0);
    expect(fp.nodeScores?.['capabilities.canonical_identity'] ?? 0).toBeGreaterThan(0);
    // The kept keywords still route.
    for (const q of ['pair with scout', 'connect with echo']) {
      const r = await triage.triage(q, layers);
      expect(r.nodeScores?.['capabilities.agent_connect'] ?? 0, q).toBeGreaterThan(0);
    }
  });
});
