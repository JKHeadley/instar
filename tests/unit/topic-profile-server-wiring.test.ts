/**
 * Wiring integrity: the TopicProfileOrchestrator + TopicProfileTransferCarrier
 * are dependency-injected components that live in the server.ts composition
 * root. Their UNIT tests (TopicProfileOrchestrator.test.ts, TopicProfileTransferCarrier.test.ts)
 * prove the logic in isolation; the E2E (topic-profile-lifecycle.test.ts) proves
 * the ROUTE + STORE layer is alive — but it constructs the AgentServer with
 * `orchestrator: null`, so neither covers the composition-root wiring.
 *
 * That wiring is exactly what failed six times during the build: the orchestrator
 * kept never getting constructed (AgentServer left holding `orchestrator: null`),
 * so the routes were alive but the respawn engine behind them was inert. This
 * test pins the composition root against the source so a refactor cannot silently
 * (1) drop the construction, (2) break the late-bind object-identity hand-off,
 * (3) stub a real dependency into a no-op, or (4) orphan a lifecycle hook
 * (write-gate / boot sweep / tick / dispose). This is the "constructed but inert"
 * failure the Testing Integrity Standard's wiring-integrity requirement guards.
 *
 * Source-parse is the established convention for composition-root wiring here
 * (see transfer-activation-wiring.test.ts, session-pool-activation-wiring.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: Topic Profile orchestrator + carrier (TOPIC-PROFILE-SPEC §8)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  describe('orchestrator construction + late-bind (the recurring orchestrator:null fix)', () => {
    it('constructs a real TopicProfileOrchestrator from orchDeps', () => {
      expect(src).toContain('const orchDeps: TopicProfileOrchestratorDeps = {');
      expect(src).toContain('_topicProfileOrchestrator = new TopicProfileOrchestrator(orchDeps);');
    });

    it('hands the SAME ctx object to AgentServer that the late-bind later mutates (object identity)', () => {
      // The ctx is passed at construction with orchestrator unset...
      expect(src).toContain('topicProfile: _topicProfileCtx ?? undefined');
      // ...then the orchestrator is late-bound onto that SAME object ref, so the
      // route layer (which closed over _topicProfileCtx) sees it. If this becomes
      // a fresh object, the routes hold a stale ctx and the orchestrator is inert.
      expect(src).toContain('_topicProfileCtx.orchestrator = _topicProfileOrchestrator;');
      // The hand-off must precede the late-bind in source order.
      const handoffIdx = src.indexOf('topicProfile: _topicProfileCtx ?? undefined');
      const lateBindIdx = src.indexOf('_topicProfileCtx.orchestrator = _topicProfileOrchestrator;');
      expect(handoffIdx).toBeGreaterThan(0);
      expect(lateBindIdx).toBeGreaterThan(handoffIdx);
    });
  });

  describe('orchestrator deps are real implementations, not no-ops', () => {
    // A few load-bearing ports: if any of these regress to a stub, the
    // orchestrator silently stops doing real work while every test stays green.
    // Slice the WHOLE orchDeps object literal: from its declaration to the
    // construction call that consumes it (the block can be >10k chars).
    const depsBlock = () => {
      const start = src.indexOf('const orchDeps: TopicProfileOrchestratorDeps = {');
      const end = src.indexOf('_topicProfileOrchestrator = new TopicProfileOrchestrator(orchDeps);', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return src.slice(start, end);
    };

    it('store + resolver delegate to the real store/resolver instances', () => {
      expect(depsBlock()).toContain('store: tpStore');
      expect(depsBlock()).toContain('resolveProfile: (topicKey) => tpResolver.resolve(topicKey)');
    });

    it('spawn port drives the real spawnSessionForTopic (not a stub)', () => {
      expect(depsBlock()).toContain('await spawnSessionForTopic(sessionManager, telegram');
    });

    it('claudeResume + killFresh delegate to the real resume map', () => {
      expect(depsBlock()).toContain('_topicResumeMap?.getProvenance(n) === \'hook\'');
      expect(depsBlock()).toContain('_topicResumeMap?.remove(Number(topic))');
    });

    it('isProtectedSession fails CLOSED to protected (§8 hard invariant), not open', () => {
      expect(depsBlock()).toContain('sessionManager.getProtectedSessions().includes(sessionName)');
      // the catch returns true (treat as protected) — never false
      expect(depsBlock()).toContain('/* @silent-fallback-ok: fail-closed to protected');
    });

    it('config gate resolves LIVE via resolveDevAgentGate (dark-by-default), not a hardcoded enabled literal', () => {
      expect(depsBlock()).toContain('enabled: resolveDevAgentGate(cfg?.enabled');
    });

    it('§11/L5 canary: production verification() ships the CONSERVATIVE arm (all false → degrade to respawn, never an unverified in-flight claim)', () => {
      const block = depsBlock();
      // v1 ships with NO independent CLI thinking-control read established, so
      // classifyProfileChange degrades every thinking/cross-model change to
      // kill+--resume rather than claiming an in-flight swap it cannot confirm.
      // A future edit that flips any of these to an UNVERIFIED `true` would make
      // the orchestrator attempt in-flight thinking swaps it can't actually
      // verify — exactly the wedge-class risk §11 guards. Pin them false.
      for (const flag of [
        'inFlightSwapConfirmedRecently: false',
        'thinkingOffOnResumeVerified: false',
        'thinkingLevelResumeVerified: false',
        'crossModelResumeVerified: false',
        'claudeThinkingControlAvailable: false',
      ]) {
        expect(block).toContain(flag);
      }
    });

    it('audit + disclose are wired to real sinks (audit file + telegram)', () => {
      expect(depsBlock()).toContain('audit: (event) => appendTopicProfileAudit(config.stateDir, event)');
      // disclose sends through the real telegram adapter (whitespace-robust check)
      expect(depsBlock()).toContain('disclose: (topicKey, text, meta) =>');
      expect(depsBlock()).toContain('.sendToTopic(n, text');
    });
  });

  describe('orchestrator lifecycle hooks are all wired (none orphaned)', () => {
    it('§8(2) gates EVERY claude resume-map writer at the single chokepoint', () => {
      expect(src).toContain('_topicResumeMap?.setWriteGate((topicId) =>');
      expect(src).toContain('_topicProfileOrchestrator!.claudeResumeWriteGate(topicId)');
    });

    it('§8(4) runs the boot reconcile sweep once at startup', () => {
      expect(src).toContain('_topicProfileOrchestrator.bootReconcileSweep();');
    });

    it('§8(4) drives a periodic tick on an unref\'d ~30s interval', () => {
      expect(src).toContain('_topicProfileOrchestrator?.tick();');
      const tickIdx = src.indexOf('const tpOrchTickTimer = setInterval(');
      expect(tickIdx).toBeGreaterThan(0);
      const block = src.slice(tickIdx, tickIdx + 400);
      expect(block).toContain('}, 30_000);');
      expect(block).toContain('tpOrchTickTimer.unref');
    });

    it('§8 disposes the orchestrator on shutdown (clears timers/locks)', () => {
      expect(src).toContain('_topicProfileOrchestrator?.dispose();');
    });

    it('records spawn success to reset the §10.4 breaker (not double-recorded when self-initiated)', () => {
      expect(src).toContain('_topicProfileOrchestrator.recordSpawnSuccess(topicId, resolvedToApplied(resolvedProfile)');
      // guarded so an orchestrator-initiated respawn does not double-count
      expect(src).toContain('!_orchestratorSpawnInFlight.has(String(topicId))');
    });

    it('the profile-write surface glues into the orchestrator (onProfileWrite)', () => {
      expect(src).toContain('_topicProfileOrchestrator?.onProfileWrite(topicKey, info)');
    });

    it('resolves the per-topic effort from the profile and threads it into the spawn options (data-flow)', () => {
      // The resolved profile's `effort` must reach spawnInteractiveSession as
      // options.effort — otherwise the pin resolves but never becomes a
      // `--effort` launch arg (the "resolved but inert" failure). Pin both the
      // resolve read and the conditional spawn-option spread.
      expect(src).toContain('const profileEffort = resolvedProfile?.effort;');
      expect(src).toContain('...(profileEffort ? { effort: profileEffort } : {}),');
      // The spawn-option spread must live inside the spawnInteractiveSession call.
      const spawnIdx = src.indexOf('sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName, {');
      expect(spawnIdx).toBeGreaterThan(0);
      const block = src.slice(spawnIdx, spawnIdx + 1200);
      expect(block).toContain('...(profileEffort ? { effort: profileEffort } : {}),');
    });

    it('§8 ingress "switch now" bridges to the orchestrator confirm surface (the disclosed instruction is not a dead end)', () => {
      // The orchestrator discloses "say 'switch now' to interrupt" and arms its
      // OWN switch-now slot; the ingress must route the operator's reply to
      // orchestrator.handleSwitchNow when no write-surface slot is armed. Pin
      // both the consult and that it is the empty-slot fallback (precedence
      // preserved — handleProfileConfirm still runs for an armed write slot).
      const swIdx = src.indexOf("case 'switch-now': {");
      expect(swIdx).toBeGreaterThan(0);
      const block = src.slice(swIdx, swIdx + 1200);
      expect(block).toContain('const r = await _topicProfileOrchestrator.handleSwitchNow(topicKey);');
      expect(block).toContain('if (r.fired) { await send(r.reply); return true; }');
      // the orchestrator consult is gated behind the empty-slot branch
      const consultIdx = block.indexOf('_topicProfileOrchestrator.handleSwitchNow');
      const fallbackIdx = block.indexOf("await send('Nothing is pending a switch right now.');");
      const handoffIdx = block.indexOf('return handleProfileConfirm(');
      expect(consultIdx).toBeGreaterThan(0);
      expect(fallbackIdx).toBeGreaterThan(consultIdx); // consult precedes the plain no-op reply
      expect(handoffIdx).toBeGreaterThan(0); // write-surface path still present (precedence preserved)
    });
  });

  describe('transfer carrier construction + mesh wiring', () => {
    it('imports + constructs a real TopicProfileTransferCarrier', () => {
      expect(src).toContain("import { TopicProfileTransferCarrier, createTopicProfilePullHandler } from '../core/TopicProfileTransferCarrier.js';");
      expect(src).toContain('_topicProfileCarrier = new TopicProfileTransferCarrier({');
      // built over the real store
      const carrierIdx = src.indexOf('_topicProfileCarrier = new TopicProfileTransferCarrier({');
      expect(src.slice(carrierIdx, carrierIdx + 200)).toContain('store: _topicProfileStore');
    });

    it('registers the topic-profile-pull mesh RPC verb backed by the real pull handler', () => {
      expect(src).toContain("'topic-profile-pull': (cmd) => {");
      expect(src).toContain('createTopicProfilePullHandler({ store: _topicProfileStore })');
    });

    it('gates the pull on the peer advertising the topic-profile-pull capability', () => {
      expect(src).toContain("caps.includes('topic-profile-pull')");
    });

    it('fires carrier hooks on the real triggers: topic-acquired, local-write-durable, tick', () => {
      expect(src).toContain('_topicProfileCarrier?.onTopicAcquired(wsTopic)');
      expect(src).toContain('_topicProfileCarrier?.onLocalWriteDurable(topicKey, origin)');
      expect(src).toContain('void _topicProfileCarrier?.tick()');
    });
  });
});
