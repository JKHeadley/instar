/**
 * Source-anchored wiring pins for the SpawnAdmission seam in
 * src/commands/server.ts (ownership-gated-spawn-and-judgment-within-floors
 * spec §3.1 — the P4 guard).
 *
 * The 2026-07-10 incident's root cause WAS a no-op injected dep: the router
 * computed the right verdict and the session-creating callsite never asked.
 * These pins are brittle-by-design and cheap to update — they fail the build
 * if a session-creating callsite loses its admit() guard, if the router
 * verdict stops being captured (TOCTOU guard), or if the constructed seam
 * stops being handed to the routes ctx.
 *
 * Style precedent: tests/unit/working-set-ownerof-wiring.test.ts (source-text
 * assertions with index-ordering checks).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');

describe('SpawnAdmission callsite pins (src/commands/server.ts)', () => {
  it('(a) all five session-creating callsites are instrumented', () => {
    // Telegram — through the admitLocalSpawn wrapper.
    expect(src).toContain("admitLocalSpawn('telegram-cold-spawn')");
    expect(src).toContain("admitLocalSpawn('telegram-respawn-context-exhausted')");
    expect(src).toContain("admitLocalSpawn('telegram-respawn-dead')");
    // Slack — direct admit() calls.
    expect(src).toContain("callsite: 'slack-inbound-spawn'");
    expect(src).toContain("callsite: 'slack-recovery-spawn'");
  });

  it('(b) the router verdict is captured AFTER the route call (TOCTOU guard, Telegram + Slack)', () => {
    const tgCapture = '_admissionVerdict = { messageId: String(msg.id), action: outcome.action, acked: outcome.acked };';
    expect(src).toContain(tgCapture);
    const tgRouteIdx = src.indexOf('const outcome = await _sessionRouter.route({');
    expect(tgRouteIdx).toBeGreaterThan(0);
    const tgCaptureIdx = src.indexOf(tgCapture);
    expect(tgCaptureIdx).toBeGreaterThan(tgRouteIdx);

    const slackCapture = '_slackAdmissionVerdict = { messageId: String(message.id), action: outcome.action, acked: outcome.acked };';
    expect(src).toContain(slackCapture);
    // The captured Slack verdict is actually threaded into the dispatch.
    expect(src).toContain('await slackInboundDispatch(message, _slackAdmissionVerdict);');
  });

  it('(b2) the seam CONSUMES the captured verdict (routerVerdict: _admissionVerdict)', () => {
    expect(src).toContain('routerVerdict: _admissionVerdict');
  });

  it('(c) the cold-spawn guard fires BEFORE spawnSessionForTopic (index ordering)', () => {
    const guard = "if (!admitLocalSpawn('telegram-cold-spawn')) return;";
    expect(src).toContain(guard);
    const guardIdx = src.indexOf(guard);
    // The cold-spawn call in the no-session else branch — the incident's exact
    // fall-through path.
    const spawnIdx = src.indexOf('spawnSessionForTopic(sessionManager, telegram, spawnName', guardIdx);
    expect(spawnIdx).toBeGreaterThan(guardIdx);
    // No OTHER spawnSessionForTopic call sits between the router verdict
    // capture and the guard on this path (the guard is not decorative).
    const between = src.slice(src.indexOf('const admitLocalSpawn = ('), guardIdx);
    expect(between).not.toContain('spawnSessionForTopic(sessionManager, telegram, spawnName');
  });

  it('(c2) both respawn callsites terminal-return on refusal', () => {
    expect(src).toContain("if (!admitLocalSpawn('telegram-respawn-context-exhausted')) return;");
    expect(src).toContain("if (!admitLocalSpawn('telegram-respawn-dead')) return;");
  });

  it('(d) construction wires provenance to the JudgmentProvenanceLog and both audit journals', () => {
    // The seam's provenance dep delegates to the constructed log — not a no-op.
    expect(src).toContain('_judgmentProvenance?.recordDecision(row)');
    // Both bounded audit journals are constructed at their canonical paths.
    expect(src).toContain("'owner-dark-ladder.jsonl'");
    expect(src).toContain("'duplicate-reconciler.jsonl'");
    // The provenance dir is the never-served/never-backed-up canonical path.
    expect(src).toContain("path.join(config.stateDir, 'state', 'judgment-provenance')");
  });

  it('(e) the routes ctx receives all four constructed instances (never silently dropped)', () => {
    expect(src).toContain('spawnAdmission: _spawnAdmission ?? undefined');
    expect(src).toContain('duplicateReconciler: _duplicateReconciler ?? undefined');
    expect(src).toContain('ownerDarkLadder: _ownerDarkLadder ?? undefined');
    expect(src).toContain('judgmentProvenance: _judgmentProvenance ?? undefined');
  });

  it('(f) the owner-dark ladder is driven from the refusal path (enforce arm exists)', () => {
    expect(src).toContain('void _ownerDarkLadder.handleOwnerDark({');
    expect(src).toContain("d.refusalAction === 'owner-dark-ladder' || d.refusalAction === 'rung3-notice'");
  });
});
