# Side-Effects Review — Organization never rules check actions, judged by meaning

**Version / slug:** `org-never-actions`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

New: `src/core/OrgActionCheck.ts` (evidence from tool input, MCP and Bash; the person's last request; masking; `OrgActionChecker` with budget, cache, records, pending checks and allow-once; `runOrgCheck`, the shared pipeline; message notes), `src/core/OrgPolicyGateHooks.ts` (hook wrapper and script text), `judgeOrgAction` in `IntentTestHarness.ts` (three-way verdict, fenced content). Routes in `orgPackRoutes.ts`: bearer `POST /org/check-action`; owner-device `GET /mobile/org/pending-checks`, `POST /mobile/org/allow-once`, `POST /mobile/org/actions-mode`. Changed: `routes.ts` (`checkOutboundMessage` runs the check, after sending in observe and before sending in block; session-context adds unread notes; `PATCH /config` refuses `orgPolicy`), `PostUpdateMigrator` (installs the hook, always overwritten; registers PreToolUse for `Bash` and `mcp__.*`), `mobilePairingRoutes` (two allowlist rules), `AgentServer` (passes the provider and config). Awareness entry `src/data/awareness/org-never-actions.md`. Spec: `docs/specs/org-never-actions.md` (6 rounds; observe approved, block not). Tier 2.

## Decision-point inventory

- Outward tool call of a joined agent — add — observe: note only; block: deny on breach or unknown.
- Outgoing message of a joined agent — add — observe: after sending, a note at next session start; block: refused before sending.
- Block mode — add — reachable only with `blockingApproved`, which nothing in this PR sets; the app switch refuses without it; `PATCH /config` refuses `orgPolicy`.
- Allow once — add — owner device only, bound to the whole action envelope, consumed atomically, refused for incomplete evidence.

---

## 1. Over-block

In observe (the only reachable mode) nothing is blocked; the worst case is a wrong note, which the agent is told to raise with its person. In block (not reachable), a false breach holds an action until the person allows it once; the evaluation set measures this before block can graduate.

## 2. Under-block

Not checked, and stated: scripts, `git push`, `npm publish`, commands outside the listed few (every part of a compound or piped command is looked at; shell expansion such as `$(…)` or variables is not evaluated; a command inside `bash -c '…'` and joined flag groups like `-sXPOST` are not looked into), the content behind an ID the agent only names (incomplete evidence), and a file changed between check and send. The judge can be wrong; observe exists to measure that. An agent that deliberately edits its own settings could remove the hook; the hook is reinstalled on every update, and agents are not adversaries in this model.

## 3. Level-of-abstraction fit

One pipeline (`runOrgCheck`) serves tool calls and messages. The judge lives beside the existing intent judges in `IntentTestHarness`. Messages reuse the `checkOutboundMessage` seam that every outbound route already calls. Device acts reuse the device-signature path and allowlist.

## 4. Signal vs authority compliance

The keyword match is recorded as a signal only. The authority is an LLM judgment with a floor: a breach must name a real rule with confidence ≥ 0.5, otherwise it is unknown. In observe the judgment has no authority at all. Block mode, where it would, waits for Justin's yes and the evaluation thresholds.

## 4b. Judgment-point check (Judgment Within Floors standard)

The judgment point is "does this action break a never rule". Floors: deterministic membership check first (no judge for a non-joined agent), evidence built from the tool input not the agent's words, content fenced as data, the verdict parsed strictly, one 9-second deadline, own daily budget.

## 5. Interactions

- External operation gate: separate PreToolUse entry, found by command content, so both run; each decides on its own.
- Coherence Gate and response review: unchanged; the message check runs beside them in `checkOutboundMessage`.
- Session start: notes appear once, labelled by conversation.
- LLM spend: own small daily budget (default in `OrgActionCheck`), counted at a fixed estimate per call (providers do not report cost), with an unlocked read-then-write, so concurrent checks can slightly exceed it. Only the agent's own provider is used: one configured for another framework is refused. The account is whatever that provider is signed into; it is not compared separately.
- Session-start notes: taken once by whoever reads `GET /intent/org/session-context` with the bearer (the session-start hook in practice).

## 6. External surfaces

Content of checked actions goes to the agent's own AI account (stated in the awareness entry and the join screen wording from org-pack). Records in `org/action-checks.jsonl` hold masked samples only.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local: each machine checks its own sessions' actions. Pending checks and allow-once are local to the machine where the action was held, which is where the person's app approves it. Membership itself replicates through org-pack.

**Status surfaces:** `GET /mobile/org/pending-checks`; records in `org/action-checks.jsonl`.

## 8. Rollback cost

Revert the code; the hook script stays on disk but its wrapper only calls a route that no longer exists, and an unanswered check passes in observe. The next update removes nothing, so a follow-up migration would delete the two settings entries if the feature were withdrawn.

## Conclusion

Ships live in observe mode for joined agents; agents that never joined pay one file test per Bash or MCP call. Unit (17), integration and alive e2e tests. A 60-case evaluation against the real judge (fast model, Claude CLI) first gave 2/20 routine flagged and 2/10 injections changing the verdict. The prompt then gained three general instructions (a breach is what the action does, text addressed to a checker is ignored, open AI disclosure is honest), and the rerun gave 0/20, 0/20, 0/10 and 0 unknown. Because the prompt was tuned after seeing this set, block mode's graduation needs a fresh held-out set as well.

## After Justin's approval: EXO 3.0 changes in this PR

Justin approved block mode on 2026-11-16 at 16:52 PST, on condition that it is EXO 3.0 compliant. An independent EXO 3.0 check found nine conditions; the spec lists them. This PR adds four of them:

- **Reply scripts.** `telegram-reply.sh`, `app-reply.sh`, `slack-reply.sh` and `whatsapp-reply.sh` show a 422 `org-policy` refusal as itself: the rule, who to ask and the checkId. Before, it reached the agent as a tone-gate block. The prior shipped SHAs for Telegram (#3095) and Slack (#2862) were added, so existing agents migrate.
- **Hook.** In block mode it never fails open: an unreadable config or unreadable input holds the action and records it. In observe mode an unanswered check adds a note and is recorded.
- **Decision journal.** Every judgment is written to the decision journal (`orgDecisionJournal`), on both the routes and the outgoing-message path. A failed check is recorded, never silent.
- **Held-out evaluation set.** 60 new cases, written after the last prompt change, pass.

Block mode stays unreachable. Its remaining conditions (the person's alert and app card, the same-provider rule with the router's failure swap turned off for this judge, real-cost budget, a live block-mode check, a code re-audit) land in the PR that turns it on.

## After the EXO 3.0 code re-audit

An independent re-audit of the block path found nine defects. These ones also matter in observe mode and are fixed in this PR:
- Joined curl flag groups (`-sd@file`, `-sXPOST`) are split.
- `gh issue|pr -F` reads the body file.
- Shell-built bodies (`$(…)`, backticks, variables) are marked incomplete.
- curl `-F "f=<file"` reads the file.
- scp and rsync option values (`-i key`, `-e …`) are never read as files to send, so a private key can't reach the judge.
- A joined agent whose policy can't be read is recorded, and held in block mode.
- Every judgment is journaled, including allowed and allowed-once, with the session id.
- The verdict cache key includes the tool.
- Unreadable hook input holds the action in block mode.

The block-only defects (a forgeable allow-once, the proxy-flag and relay paths, provider pinning, late usage) are fixed in the block-mode PR before `blockingApproved` is set.



**Reviewer:** second-pass subagent (two reads)
**Independent read of the artifact: concur** (second read)

The first read did not concur. It found that in block mode a refused message was still sent, that number and boolean tool arguments were ignored, that only the first part of a compound or piped command was checked, that allow-once did not bind the full command, that a message note could be lost, that the mode switch had its own config write, and that the observe message check ran before sending. All were fixed. The second read confirmed each fix with file and line, and found no new defect from them. Its small leftovers are applied too: a single `&` and parentheses are now split, the over-long-message refusal says so plainly, and the remaining shell gaps are stated in §2. The iMessage route answers 2xx when it issues a send token, so there the observe check runs slightly before the actual send; harmless in observe.

## Evidence pointers

- `tests/unit/org-action-check.test.ts`, `tests/integration/org-never-actions.test.ts`, `tests/e2e/org-never-actions-alive.test.ts`, `tests/fixtures/org-never-actions-eval.json`.

## Rule-test fixes (merge line, 2026-11-16)

Three catches in the generated hook script were already recorded or held, but lacked the `@silent-fallback-ok` note the silent-fallback test looks for, and one was an empty `catch {}`. They now carry the note and a reason. The spec's ladder line now says "not applicable" with its reason, because no feature-ladder entry governs this rollout.

## Local verify fixes (2026-11-17)

Local verify ran three rule tests against a merge with main and failed them; all three are fixed here, and 35/35 pass on that merge.
- **The model-call label:** `OrgPolicyJudge` (the model call that judges an action against the organization's rules) is registered as a `gate` in `src/core/componentCategories.ts`, with its row in `docs/LLM-ROUTING-REGISTRY.md` (fast tier, explicit category, as `IntentLlmJudge`).
- **New agents:** `instar init` now writes `org-policy-gate.sh` and `org-policy-gate.js` too, so a new agent gets the gate as an existing one does on update. It allows everything until the agent joins an organization.
- **The conversation key:** with a topic id, an outgoing message's organization check is keyed by the plain topic id, as the other channels key theirs. It was "topic <id>", which the topic-reference rule counts as a bare render, and it would have changed if the format of topic references changed.

## Local-verify fix (merge line, 2026-11-17 13:35Z)

Local verify failed 7 unit tests in 6 ratchets because OrgPolicyJudge had no classification. Added: LLM_BENCH_COVERAGE pending wave-3, LLM_UNTRUSTED_INPUT true, LLM_JUDGES_CLAIMS false, LLM_PARSER_CONTRACT pending contract-wave-2, LLM_ROUTING_NATURE B/JUDGE, LLM_ROUTING_INJECTION_EXPOSURE exposed(all), and a provenance census entry pending decision-quality enrolment; the pinned pending baselines in the bench, parser-contract and provenance ratchets gain the one entry. No runtime behaviour changes. 98/98.
