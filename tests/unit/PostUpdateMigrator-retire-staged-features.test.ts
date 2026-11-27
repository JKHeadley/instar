/**
 * Tests for the retirement migration of spec retire-staged-features-2026-10-25
 * (CMT-1004) — acceptance criterion 3:
 *   - migrateRetireStagedFeaturesCmt1004 — removes the six retired config blocks
 *     (+ the junk top-level `quotaLimits` at its known value only), records every
 *     removal with schema scalars only, REVIEW-prefixes a block that was switched
 *     on, honors `_instar_noMigrate`, idempotent via the `_instar_migrations` marker.
 *   - migrateClaudeMd — strips the retired Jev review-flag-shadow card from
 *     CLAUDE.md and the Codex/Gemini mirrors only when the paragraph equals the
 *     frozen text; rewords the pool card's transfer / triggers / closeout bullets;
 *     inserts the topic-profile propose bullet once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PostUpdateMigrator,
  JEV_REVIEW_FLAG_CARD_RETIRED,
  JEV_REVIEW_FLAG_CARD_RETIRED_HEADING,
  stripRetiredJevReviewFlagCard,
  topicProfileProposeBullet,
} from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const fresh = (): Result => ({ upgraded: [], skipped: [], errors: [] });

function buildMigrator(projectDir: string): PostUpdateMigrator {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runConfigStep(m: PostUpdateMigrator, r: Result): void {
  (m as unknown as { migrateRetireStagedFeaturesCmt1004: (r: Result) => void }).migrateRetireStagedFeaturesCmt1004(r);
}
function runClaudeMdStep(m: PostUpdateMigrator, r: Result): void {
  (m as unknown as { migrateClaudeMd: (r: Result) => void }).migrateClaudeMd(r);
}

function readConfig(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
}
function writeConfig(stateDir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
}

const DEFAULT_BLOCKS = {
  cartographer: { enabled: false, conformanceAudit: { enabled: false, llmEnrichment: { enabled: false, modelTier: 'fast' } }, subtreeNav: { llmRerank: { enabled: false, timeoutMs: 1500 } } },
  intelligence: { jevReviewFlagShadow: { enabled: false, maxChecksPerDay: 500, tickIntervalMs: 60000 } },
  monitoring: { proactiveAutonomousCompaction: { enabled: false, dryRun: true } },
  multiMachine: { sessionPool: { stage: 'dark', moveIntent: { enabled: false, dryRun: true, minConfidence: 0.85, timeoutMs: 4000 } } },
  topicProfiles: { dryRun: true, intentClassifier: { enabled: false, dryRun: true, contextWindowTurns: 3 } },
};

describe('PostUpdateMigrator.migrateRetireStagedFeaturesCmt1004 (config)', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-retire-staged-'));
    stateDir = path.join(projectDir, '.instar');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'retire-staged test' });
  });

  it('removes every retired block present at its defaults with ONE upgraded line (no REVIEW), parents kept', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, structuredClone(DEFAULT_BLOCKS));
    const r = fresh();
    runConfigStep(m, r);
    expect(r.errors).toEqual([]);
    const post = readConfig(stateDir);
    const cart = post.cartographer as Record<string, Record<string, unknown>>;
    expect(cart.conformanceAudit.llmEnrichment).toBeUndefined();
    expect(cart.conformanceAudit.enabled).toBe(false); // sibling untouched
    expect(cart.subtreeNav).toEqual({}); // emptied parent stays as {}
    expect((post.intelligence as Record<string, unknown>).jevReviewFlagShadow).toBeUndefined();
    expect((post.monitoring as Record<string, unknown>).proactiveAutonomousCompaction).toBeUndefined();
    expect(((post.multiMachine as Record<string, Record<string, unknown>>).sessionPool).moveIntent).toBeUndefined();
    expect(((post.multiMachine as Record<string, Record<string, unknown>>).sessionPool).stage).toBe('dark');
    expect((post.topicProfiles as Record<string, unknown>).intentClassifier).toBeUndefined();
    expect((post.topicProfiles as Record<string, unknown>).dryRun).toBe(true);
    // One line, all six keys, schema scalars only, no REVIEW prefix.
    expect(r.upgraded).toHaveLength(1);
    const line = r.upgraded[0];
    expect(line).not.toMatch(/REVIEW/);
    for (const key of [
      'cartographer.conformanceAudit.llmEnrichment',
      'cartographer.subtreeNav.llmRerank',
      'intelligence.jevReviewFlagShadow',
      'monitoring.proactiveAutonomousCompaction',
      'multiMachine.sessionPool.moveIntent',
      'topicProfiles.intentClassifier',
    ]) expect(line).toContain(key);
    expect(line).toContain('modelTier=fast');
    expect(line).toContain('minConfidence=0.85');
    expect(line).toContain('contextWindowTurns=3');
    expect((post._instar_migrations as string[]).some((x) => x.startsWith('retire-staged-features-cmt1004-v1'))).toBe(true);
  });

  it('a block that was switched on (enabled: true) is removed with its own REVIEW line carrying the scalars and the replacement lever', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, {
      multiMachine: { sessionPool: { moveIntent: { enabled: true, dryRun: false, minConfidence: 0.9, timeoutMs: 4000, framework: 'codex-cli' } } },
      topicProfiles: { intentClassifier: { enabled: false, dryRun: true } },
    });
    const r = fresh();
    runConfigStep(m, r);
    const post = readConfig(stateDir);
    expect(((post.multiMachine as Record<string, Record<string, unknown>>).sessionPool).moveIntent).toBeUndefined();
    const review = r.upgraded.find((l) => l.startsWith('REVIEW:'));
    expect(review).toBeDefined();
    expect(review).toContain('multiMachine.sessionPool.moveIntent');
    expect(review).toContain('enabled=true');
    expect(review).toContain('dryRun=false');
    expect(review).toContain('minConfidence=0.9');
    expect(review).toContain('framework=codex-cli');
    expect(review).toContain('POST /pool/transfer');
    // The default-shaped sibling is on the plain line, not the REVIEW line.
    const plain = r.upgraded.find((l) => !l.startsWith('REVIEW:'));
    expect(plain).toContain('topicProfiles.intentClassifier');
    expect(plain).not.toContain('moveIntent');
  });

  it('dryRun: false alone also earns the REVIEW prefix', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { topicProfiles: { intentClassifier: { enabled: false, dryRun: false } } });
    const r = fresh();
    runConfigStep(m, r);
    expect(r.upgraded.some((l) => l.startsWith('REVIEW:') && l.includes('topicProfiles.intentClassifier') && l.includes('/topic-profile/TOPIC_ID/propose'))).toBe(true);
  });

  it('never echoes free text — an unexpected string scalar shape is reported by type only', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { intelligence: { jevReviewFlagShadow: { enabled: false, modelTier: 'this is a long free-text value with spaces', note: 'operator note' } } });
    const r = fresh();
    runConfigStep(m, r);
    expect(r.upgraded).toHaveLength(1);
    expect(r.upgraded[0]).toContain('modelTier=<string>');
    expect(r.upgraded[0]).not.toContain('free-text');
    expect(r.upgraded[0]).not.toContain('operator note');
  });

  it('removes the junk top-level quotaLimits {"enabled": false} and reports it as an unknown key', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { quotaLimits: { enabled: false }, other: 1 });
    const r = fresh();
    runConfigStep(m, r);
    const post = readConfig(stateDir);
    expect('quotaLimits' in post).toBe(false);
    expect(post.other).toBe(1);
    expect(r.upgraded).toHaveLength(1);
    expect(r.upgraded[0]).toMatch(/quotaLimits \(unknown key; enabled=false\)/);
  });

  it('leaves a non-junk quotaLimits in place and REVIEWs it WITHOUT its value', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { quotaLimits: { enabled: true, perUserSecretValue: 'do-not-echo-me' } });
    const r = fresh();
    runConfigStep(m, r);
    const post = readConfig(stateDir);
    expect(post.quotaLimits).toEqual({ enabled: true, perUserSecretValue: 'do-not-echo-me' });
    const review = r.upgraded.find((l) => l.startsWith('REVIEW:') && l.includes('quotaLimits'));
    expect(review).toBeDefined();
    expect(review).not.toContain('do-not-echo-me');
    expect(review).not.toContain('enabled=true');
    expect(review).toContain('value not shown');
  });

  it('honors _instar_noMigrate — a listed path (full, prefix or bare key) is skipped and reported', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, {
      _instar_noMigrate: ['multiMachine.sessionPool.moveIntent', 'llmRerank', 'quotaLimits'],
      multiMachine: { sessionPool: { moveIntent: { enabled: false } } },
      cartographer: { subtreeNav: { llmRerank: { enabled: false } } },
      quotaLimits: { enabled: false },
      topicProfiles: { intentClassifier: { enabled: false } },
    });
    const r = fresh();
    runConfigStep(m, r);
    const post = readConfig(stateDir);
    expect(((post.multiMachine as Record<string, Record<string, unknown>>).sessionPool).moveIntent).toEqual({ enabled: false });
    expect(((post.cartographer as Record<string, Record<string, unknown>>).subtreeNav).llmRerank).toEqual({ enabled: false });
    expect(post.quotaLimits).toEqual({ enabled: false });
    expect((post.topicProfiles as Record<string, unknown>).intentClassifier).toBeUndefined();
    expect(r.skipped.filter((s) => s.includes('opted out via _instar_noMigrate'))).toHaveLength(3);
    expect(r.skipped.some((s) => s.includes('multiMachine.sessionPool.moveIntent'))).toBe(true);
    expect(r.skipped.some((s) => s.includes('cartographer.subtreeNav.llmRerank'))).toBe(true);
    expect(r.skipped.some((s) => s.includes('quotaLimits'))).toBe(true);
    expect(r.upgraded).toHaveLength(1);
    expect(r.upgraded[0]).toContain('topicProfiles.intentClassifier');
    expect(r.upgraded[0]).not.toContain('moveIntent');
  });

  it('IDEMPOTENT: a second run is a no-op (marker)', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, structuredClone(DEFAULT_BLOCKS));
    const r1 = fresh();
    runConfigStep(m, r1);
    expect(r1.upgraded).toHaveLength(1);
    // Re-introduce a key the way a stale peer sync would — the marker gates it; not a perpetual scrubber.
    const cfg = readConfig(stateDir);
    (cfg.intelligence as Record<string, unknown>).jevReviewFlagShadow = { enabled: false };
    writeConfig(stateDir, cfg);
    const r2 = fresh();
    runConfigStep(m, r2);
    expect(r2.upgraded).toEqual([]);
    expect(r2.errors).toEqual([]);
    expect(r2.skipped.some((s) => s.includes('already migrated'))).toBe(true);
    expect((readConfig(stateDir).intelligence as Record<string, unknown>).jevReviewFlagShadow).toEqual({ enabled: false });
  });

  it('nothing present → marker set, skipped "nothing to remove"', () => {
    const m = buildMigrator(projectDir);
    writeConfig(stateDir, { monitoring: { enabled: true } });
    const r = fresh();
    runConfigStep(m, r);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.skipped.some((s) => s.includes('nothing to remove'))).toBe(true);
    expect((readConfig(stateDir)._instar_migrations as string[]).some((x) => x.startsWith('retire-staged-features-cmt1004-v1'))).toBe(true);
  });

  it('missing config.json → skipped', () => {
    const m = buildMigrator(projectDir);
    const r = fresh();
    runConfigStep(m, r);
    expect(r.errors).toEqual([]);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.some((s) => s.includes('config.json not found'))).toBe(true);
  });

  it('unparseable config.json → errors entry, file byte-identical', () => {
    const m = buildMigrator(projectDir);
    const p = path.join(stateDir, 'config.json');
    const junk = '{ "monitoring": { "proactiveAutonomousCompaction": { "enabled": false }, ';
    fs.writeFileSync(p, junk);
    const r = fresh();
    runConfigStep(m, r);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/retire staged features/);
    expect(r.upgraded).toEqual([]);
    expect(fs.readFileSync(p, 'utf-8')).toBe(junk);
  });
});

describe('stripRetiredJevReviewFlagCard (pure)', () => {
  const port = 4042;
  const card = JEV_REVIEW_FLAG_CARD_RETIRED(port);
  const paragraph = card.slice(('\n\n' + JEV_REVIEW_FLAG_CARD_RETIRED_HEADING + '\n\n').length, -1);

  it('strips the generated card appended before a later plain-paragraph append, neighbours intact', () => {
    const before = '# Agent\n\nSome body.\n\n### Jev Circles Shadow\n\nCircles paragraph.\n';
    const after = '\nQueued-message review pacing: the next append.\n';
    const file = before + card + after;
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(1);
    expect(r.review).toBe(false);
    expect(r.content).toBe(before + after);
    expect(r.content).not.toContain('Jev Review-Flag');
  });

  it('strips the template-generated inline card (blank-line separated, followed by the next card)', () => {
    const tpl = generateClaudeMd('x', 'Agent', port, false);
    // The current template no longer carries it — rebuild the legacy layout around the Token-Burn card.
    expect(tpl).not.toContain(JEV_REVIEW_FLAG_CARD_RETIRED_HEADING);
    const legacy = tpl.replace('**Token-Burn Alerts**', JEV_REVIEW_FLAG_CARD_RETIRED_HEADING + '\n\n' + paragraph + '\n\n**Token-Burn Alerts**');
    expect(legacy).toContain(JEV_REVIEW_FLAG_CARD_RETIRED_HEADING);
    const r = stripRetiredJevReviewFlagCard(legacy, port);
    expect(r.stripped).toBe(1);
    expect(r.content).toBe(tpl);
  });

  it('CRLF file → stripped (compared after normalisation)', () => {
    const file = ('# Agent\n\nBody.\n' + card + '\nNext.\n').replace(/\n/g, '\r\n');
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(1);
    expect(r.content).toBe('# Agent\n\nBody.\n\nNext.\n');
  });

  it('a different port in the deployed card still matches (localhost:<n> → PORT)', () => {
    const file = '# Agent\n' + JEV_REVIEW_FLAG_CARD_RETIRED(4040) + '\nNext.\n';
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(1);
    expect(r.content).toBe('# Agent\n\nNext.\n');
  });

  it('generated first sentence + edited remainder → untouched + review', () => {
    const edited = paragraph.slice(0, paragraph.indexOf('Once a minute')) + 'Every five minutes my operator tuned this. Custom text.';
    const file = '# Agent\n\n' + JEV_REVIEW_FLAG_CARD_RETIRED_HEADING + '\n\n' + edited + '\n\nNext.\n';
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(0);
    expect(r.review).toBe(true);
    expect(r.content).toBe(file);
  });

  it('generated paragraph followed by a custom paragraph → only the generated one stripped', () => {
    const custom = 'My own note under that heading that I want to keep.';
    const file = '# Agent\n\nBody.\n' + card + '\n' + custom + '\n';
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(1);
    expect(r.review).toBe(false);
    expect(r.content).toBe('# Agent\n\nBody.\n\n' + custom + '\n');
  });

  it('loops over duplicate headings', () => {
    const file = '# Agent\n' + card + card + '\nNext.\n';
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r.stripped).toBe(2);
    expect(r.content).toBe('# Agent\n\nNext.\n');
  });

  it('card absent → byte-identical, no review', () => {
    const file = '# Agent\r\n\r\nBody.\r\n';
    const r = stripRetiredJevReviewFlagCard(file, port);
    expect(r).toEqual({ content: file, stripped: 0, review: false });
  });
});

describe('PostUpdateMigrator.migrateClaudeMd (retire-staged-features card cleanup + pool / topic-profile rewording)', () => {
  let projectDir: string;
  const port = 4042;
  const card = JEV_REVIEW_FLAG_CARD_RETIRED(port);

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-retire-staged-md-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'retire-staged md test' });
  });

  const read = (name: string): string => fs.readFileSync(path.join(projectDir, name), 'utf-8');

  it('strips the generated card from CLAUDE.md AND AGENTS.md (each followed by a plain paragraph), neighbours intact', () => {
    const m = buildMigrator(projectDir);
    const before = '# Agent\n\nBody.\n\n### Jev Circles Shadow\n\nCircles paragraph.\n';
    const after = '\nQueued-message review pacing: later append.\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), before + card + after);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Shadow\n' + card + after);
    const r = fresh();
    runClaudeMdStep(m, r);
    expect(r.errors).toEqual([]);
    const claude = read('CLAUDE.md');
    expect(claude).not.toContain('Jev Review-Flag');
    expect(claude.startsWith(before + after.trimEnd())).toBe(true); // neighbours intact, later appends follow
    expect(read('AGENTS.md')).toBe('# Shadow\n' + after);
    expect(r.upgraded.some((l) => l.startsWith('CLAUDE.md: removed the retired Jev review-flag-shadow card'))).toBe(true);
    expect(r.upgraded.some((l) => l.startsWith('AGENTS.md: removed the retired Jev review-flag-shadow card'))).toBe(true);
    expect(r.upgraded.some((l) => l.startsWith('REVIEW:') && l.includes('Jev Review-Flag'))).toBe(false);
  });

  it('CRLF CLAUDE.md → stripped', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), ('# Agent\n\nBody.\n' + card + '\nNext.\n').replace(/\n/g, '\r\n'));
    const r = fresh();
    runClaudeMdStep(m, r);
    expect(read('CLAUDE.md')).not.toContain('Jev Review-Flag');
    expect(read('CLAUDE.md').startsWith('# Agent\n\nBody.\n\nNext.\n')).toBe(true);
  });

  it('edited paragraph → untouched + one REVIEW line naming the file and heading', () => {
    const m = buildMigrator(projectDir);
    const edited = '# Agent\n\n' + JEV_REVIEW_FLAG_CARD_RETIRED_HEADING + '\n\nA dark research instrument (spec: jev-review-flag-shadow.md). My operator rewrote the rest.\n\nNext.\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), edited);
    fs.writeFileSync(path.join(projectDir, 'GEMINI.md'), edited);
    const r = fresh();
    runClaudeMdStep(m, r);
    expect(read('CLAUDE.md').startsWith(edited)).toBe(true);
    expect(read('GEMINI.md')).toBe(edited);
    const reviews = r.upgraded.filter((l) => l.startsWith('REVIEW:') && l.includes(JEV_REVIEW_FLAG_CARD_RETIRED_HEADING));
    expect(reviews).toHaveLength(2);
    expect(reviews.some((l) => l.startsWith('REVIEW: CLAUDE.md:'))).toBe(true);
    expect(reviews.some((l) => l.startsWith('REVIEW: GEMINI.md:'))).toBe(true);
  });

  it('card absent → no strip line, no REVIEW', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\nBody.\n');
    const r = fresh();
    runClaudeMdStep(m, r);
    expect(r.upgraded.some((l) => l.includes('Jev review-flag') || l.includes('Jev Review-Flag'))).toBe(false);
    expect(read('CLAUDE.md')).not.toContain('Jev Review-Flag');
  });

  const OLD_TRANSFER_TEMPLATE = '- **Reliable transfer (phrasing-independent):** `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/pool/transfer -H \'Content-Type: application/json\' -d \'{"topic":N,"to":"<nickname|machineId>"}\'` → runs the same validated planner as "move this to <nickname>" but deterministically (no NL recognition). 404 unknown machine · 409 rate-limited · 409 `needsConfirmation` for an offline target OR an in-flight autonomous run. To confirm, re-send the same request with `"confirm":true` AND the returned `confirmationChallenge`; changed conditions return a fresh challenge instead of consuming stale consent. This is the lever to call directly when a natural-language move didn\'t catch.';
  const OLD_TRANSFER_MIGRATOR = '- **Reliable transfer (phrasing-independent):** `POST /pool/transfer` with `{"topic":N,"to":"<nickname|machineId>"}` runs the same validated planner as "move this to <nickname>" but deterministically. 404 unknown · 409 rate-limited · 409 `needsConfirmation` for an offline target (re-send with `"confirm":true`). The lever to call directly when a natural-language move didn\'t catch.';
  const OLD_TRIGGERS_TEMPLATE = '- **Proactive triggers:** when the user says "run this on <nickname>" / "move this to <nickname>" → that\'s a placement/transfer-by-nickname (a session moves to the named machine, resuming like a session restart). "where is this running / why?" → `GET /pool/placement?topic=N`. "move it reliably / it didn\'t move" → `POST /pool/transfer`. Deep mechanics: the Machines tab + `docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md`.';
  const OLD_TRIGGERS_MIGRATOR = '- **Proactive triggers:** when the user says "run this on <nickname>" / "move this to <nickname>" → placement/transfer-by-nickname (the session moves to the named machine, resuming like a session restart). "where is this running / why?" → `GET /pool/placement?topic=N`. "move it reliably / it didn\'t move" → `POST /pool/transfer`. Deep mechanics: the Machines tab + `docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md`.';
  const OLD_CLOSEOUT = '- **Post-transfer closeout (automatic):** when a topic moves to another machine, the OLD machine\'s session for it is closed automatically (immediately on an explicit "move", or within ~2 reaper ticks for any other path) — no duplicate sessions doing duplicate work. The close is recorded in the reap-log with reason "topic moved to <machine>"; protected sessions are never auto-closed.';
  const NEW_TRANSFER_TAIL = '— the lever I call when the user asks to move a conversation (the server does not recognise the phrase itself).';
  const NEW_TRIGGERS = '- **Proactive triggers:** when the user asks to move / run / pin a conversation on a machine ("run this on <nickname>", "move this to <nickname>") → `POST /pool/transfer` (the session moves to the named machine, resuming like a session restart). "where is this running / why?" → `GET /pool/placement?topic=N`. Deep mechanics: the Machines tab + `docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md`.';
  const NEW_CLOSEOUT_PAREN = '(closed by the transfer\'s drain step when the current machine can drain, otherwise within ~2 reaper ticks)';

  // A pool card that already carries every later insert's sniff key, so the
  // migration only rewords (nothing is appended into the card).
  const poolCardWith = (transfer: string, triggers: string): string => [
    '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
    '',
    'Beyond the one-awake-machine model. `/pool/machines/` `/session-pool/promote` `/pool/placement` autonomousRunSuspended confirmationChallenge sessions?scope=pool `/pool/unpin` pool.machines[].emptyState Quota-aware placement remote-close',
    '',
    OLD_CLOSEOUT,
    transfer,
    triggers,
    '',
  ].join('\n');

  it('both deployed transfer-card wordings are replaced, and the closeout + triggers bullets reworded (template-generated form)', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\n' + poolCardWith(OLD_TRANSFER_TEMPLATE, OLD_TRIGGERS_TEMPLATE));
    const r = fresh();
    runClaudeMdStep(m, r);
    const out = read('CLAUDE.md');
    expect(out).not.toContain('but deterministically');
    expect(out).not.toContain("natural-language move didn't catch");
    expect(out).not.toContain('(no NL recognition)');
    expect(out).toContain('runs the same validated planner as "move this to <nickname>" ' + NEW_TRANSFER_TAIL + ' 404 unknown machine');
    expect(out).toContain('instead of consuming stale consent.\n'); // trailing sentence gone, period kept
    expect(out).not.toContain('move it reliably');
    expect(out).toContain(NEW_TRIGGERS);
    expect(out).not.toContain('immediately on an explicit');
    expect(out).toContain(NEW_CLOSEOUT_PAREN);
    expect(out.match(/- \*\*Proactive triggers:\*\*/g)).toHaveLength(1);
    expect(r.upgraded.some((l) => l.includes('reworded the Multi-Machine Session Pool'))).toBe(true);
  });

  it('migrator-inserted form: the same rewording applies', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\n' + poolCardWith(OLD_TRANSFER_MIGRATOR, OLD_TRIGGERS_MIGRATOR));
    const r = fresh();
    runClaudeMdStep(m, r);
    const out = read('CLAUDE.md');
    expect(out).not.toContain('but deterministically');
    expect(out).not.toContain("natural-language move didn't catch");
    expect(out).toContain('runs the same validated planner as "move this to <nickname>" ' + NEW_TRANSFER_TAIL + ' 404 unknown · 409 rate-limited');
    expect(out).toContain('(re-send with `"confirm":true`).\n');
    expect(out).toContain(NEW_TRIGGERS);
    expect(out).toContain(NEW_CLOSEOUT_PAREN);
    // Second run: nothing left to reword.
    const r2 = fresh();
    runClaudeMdStep(m, r2);
    expect(r2.upgraded.some((l) => l.includes('reworded the Multi-Machine Session Pool'))).toBe(false);
    expect(read('CLAUDE.md')).toBe(out);
  });

  it('pool card absent → inserted with the new wording only', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\nBody.\n');
    const r = fresh();
    runClaudeMdStep(m, r);
    const out = read('CLAUDE.md');
    expect(out).toContain('## Multi-Machine Session Pool (active-active');
    expect(out).toContain(NEW_TRANSFER_TAIL);
    expect(out).toContain(NEW_TRIGGERS);
    expect(out).toContain(NEW_CLOSEOUT_PAREN);
    expect(out).not.toContain('but deterministically');
    expect(out).not.toContain("natural-language move didn't catch");
    expect(out).not.toContain('move it reliably');
    expect(out).not.toContain('immediately on an explicit');
    // The insert alone converges — the replace step had nothing to do.
    expect(r.upgraded.some((l) => l.includes('reworded the Multi-Machine Session Pool'))).toBe(false);
  });

  it('template parity: generateClaudeMd carries the new pool wording and the propose bullet, never the old', () => {
    const tpl = generateClaudeMd('x', 'Agent', port, false);
    expect(tpl).toContain(NEW_TRANSFER_TAIL);
    expect(tpl).toContain(NEW_TRIGGERS);
    expect(tpl).toContain(NEW_CLOSEOUT_PAREN);
    expect(tpl).toContain(topicProfileProposeBullet(port));
    expect(tpl).not.toContain('but deterministically');
    expect(tpl).not.toContain("natural-language move didn't catch");
    expect(tpl).not.toContain('move it reliably');
    expect(tpl).not.toContain('immediately on an explicit');
    expect(tpl).not.toContain(JEV_REVIEW_FLAG_CARD_RETIRED_HEADING);
  });

  it('propose bullet: inserted ONCE right after "What is this topic pinned to?" when the Topic Profile card is present; second run no-op', () => {
    const m = buildMigrator(projectDir);
    const pinned = '- What is this topic pinned to? `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/topic-profile/TOPIC_ID` — Registry First: read it, never guess (no entry = the topic runs on defaults).';
    const why = '- Why/when did a pin change? Read `logs/topic-profile-changes.jsonl` — the per-change audit (who set what, when, old → new).';
    const card = '**Topic Profile (per-topic model, thinking, framework pins)** — Every conversation topic can carry a durable profile.\n' + pinned + '\n' + why + '\n- Config: `.instar/config.json` → `topicProfiles` (dry run).\n- **Dashboard door + model controls** x\n- **Dashboard machine choice** y\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\n' + card);
    const r = fresh();
    runClaudeMdStep(m, r);
    const out = read('CLAUDE.md');
    expect(out).toContain(pinned + '\n' + topicProfileProposeBullet(port) + '\n' + why + '\n');
    expect(out.split('/topic-profile/TOPIC_ID/propose')).toHaveLength(2);
    expect(r.upgraded.some((l) => l.includes('propose bullet'))).toBe(true);
    const r2 = fresh();
    runClaudeMdStep(m, r2);
    expect(r2.upgraded.some((l) => l.includes('propose bullet'))).toBe(false);
    expect(read('CLAUDE.md').split('/topic-profile/TOPIC_ID/propose')).toHaveLength(2);
  });

  it('propose bullet: Topic Profile card absent → the backfilled card already carries it (no second insert)', () => {
    const m = buildMigrator(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n\nBody.\n');
    const r = fresh();
    runClaudeMdStep(m, r);
    const out = read('CLAUDE.md');
    expect(out).toContain('Topic Profile (per-topic model');
    expect(out.split('/topic-profile/TOPIC_ID/propose')).toHaveLength(2);
    expect(out).toContain('- What is this topic pinned to? `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/topic-profile/TOPIC_ID` — Registry First: read it, never guess (no entry = the topic runs on defaults).\n' + topicProfileProposeBullet(port) + '\n- Why/when did a pin change?');
  });
});
