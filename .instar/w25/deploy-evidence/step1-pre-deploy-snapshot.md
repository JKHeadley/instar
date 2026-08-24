# Step 1 — pre-deploy snapshot

Taken 2026-08-24T03:14:31Z on DaBombs-Mac-Studio.local, BEFORE any deployment. This is the 'before' half of every Step-5 live proof.

## Running version
- server version: 1.3.1197 | pid uptime: 414005
- shadow-install package: 1.3.1197

## Guard posture summary
-  {"onConfirmed": 19, "onUnverified": 43, "onStale": 1, "onBlind": 0, "onDryRun": 12, "off": 17, "offDeviant": 6, "offDarkDefault": 11, "divergedPendingRestart": 0, "errored": 0, "missing": 0, "offRuntimeDivergent": 0, "runtimeEnriched": "27/92", "loadBearingGapKeys": ["intelligence.testRunnerCap", "monitoring.correctionClassReview.enabled", "multiMachine.meshTransport.recoveryProbeEnabled", "multiMachine.sessionPool.inboundQueue.enabled"], "loadBearingUninspectableKeys": [], "loadBearingSoakingKeys": ["multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled"], "loadBearingAcceptedKeys": []}

## Session census
- Cross-machine conversation coherence | claude-code | running | started 2026-08-23T18:27:19.829Z
- Grok/Cursor | claude-code | running | started 2026-08-23T20:55:57.608Z
- Multi-machine placement & load measurement | claude-code | running | started 2026-08-23T05:52:55.722Z
- Deepseek harness | claude-code | running | started 2026-08-24T00:35:51.702Z
- 🔭2 Observer 2 (GPT-5.6-Sol) | codex-cli | running | started 2026-08-22T20:51:50.726Z
- observer | claude-code | running | started 2026-08-23T20:10:45.863Z
- 🔬 LLM Pathway Characterization | claude-code | running | started 2026-08-23T19:32:35.913Z

## On-disk hook registrations (with control)
- .claude/settings.json registrations: 36
- control (settings.RESTORED.json, the 36-target): 36

## Live-proof baselines (the 'before' for each Step-5 ref)
- /decision-quality -> HTTP 200
- /sessions/reap-log -> HTTP 200
- /conformance/coverage/health -> HTTP 409
- /blockers/self-unblock-runs -> HTTP 200

## Live-proof baselines — measured values (the facts the Step-5 proofs must change)
- lane-f (reap-log): last 3 self-exit rows all carry exitCode=null midWork=null outcome=null (w25-lane-4/5/6 at 00:14Z, 00:52Z, 01:52Z). Proof = a controlled self-exit writes all three.
- lane-a-fix-1 (decision grading): 39 decision points, settled right+wrong over 7d = 0. The grader has never graded. Proof = settled > 0 with a wrong arm exercised.
- lane-a-fix-4 (conformance): STILL LIVE, verified. GET /conformance/coverage/health?topicId=29723 with header X-Instar-Request: 1 -> HTTP 200 {enabled:true, usable:true, converged:true}. Controls: same request WITHOUT the header -> 403 ("requires the X-Instar-Request: 1 intent header"); WITHOUT topicId -> 409 topic-binding-required. Both are the route's SHAPE. The 29723 binding is present and identical to what fix-4 wrote. Record of error: an earlier version of this line claimed STILL LIVE on an unchecked status variable (it was 403), was retracted, and is now re-asserted on the measured 200.
- lane-a-fix-2 (#22 self-unblock): STILL LIVE, verified 03:20Z. GET /blockers/self-unblock-runs?limit=1 -> 200 with a REAL run in the store (SUN-mt58b5mw-xfod1w, completed 2026-08-23T03:09:46Z). Stronger than fix-2's own measurement, which was 200 with an empty store. Control: fix-2 recorded the pre-activation 503 on this route.
- lane-e (sessions-read discrepancy probe): BEFORE = absent. 0 matching lines in logs/server.log; no route surfaces it. Correct — lane-e is in the candidate, not deployed. Proof = a probe line/route appears after deploy.
- lane-b2 (authorship at the re-read boundary): BEFORE measured 03:22Z on GET /telegram/topics/29723/messages?limit=5 (+X-Instar-Request: 1): rows=5 with_authorship=0 keys=['fromUser', 'messageId', 'provenance', 'sessionName', 'text', 'timestamp', 'topicId']. b2's artifact measured at TelegramAdapter.getTopicHistory()/searchLog(), NOT at an HTTP consumer, so this is the first consumer-side baseline. Proof = the same request returns rows WITH an authorship field.
- lane-a-fix-3 (#4 attention READ / #26 passport): BEFORE measured 03:23Z. GET /attention?limit=2 returned 146 rows; ?status=OPEN returned 138. fix-3's #4 defect was `limit` ignored (1006 vs 254 in W24). /passport answers 200 with agent+fingerprint. Proof = limit honoured (≤2 rows) and passport identity matches provenance fingerprint.
- lane-a-fix-3 (#26 passport, target pinned): /provenance canonical fingerprint = 63b1dbb21646e2f5… ; /passport fingerprint = unresolved. Proof = /passport.fingerprint equals the canonical value.
- Server-restart exposure during suite runs: CLOSED. Four server restarts occurred inside suite windows tonight. 193 e2e files boot their own server; only 2 reference the live :4042 (mesh-endpoint-propagation wiring + integration). Both PASSED in the a11014456 run (3/3, 5/5) at 03:35Z. No suite result depended on the live server's identity.
