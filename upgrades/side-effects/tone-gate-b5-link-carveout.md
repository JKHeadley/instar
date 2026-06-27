# Side-Effects Review — Tone Gate B5: stop blocking user-facing share links

**Version / slug:** `tone-gate-b5-link-carveout`
**Date:** `2026-06-27`
**Author:** `echo`
**Second-pass reviewer:** `echo (dedicated reviewer subagent)`

## Summary of the change

The outbound MessagingToneGate's B5_API_ENDPOINT rule was blocking user-facing share links — private-view links (`/view/<id>?token=…`), Cloudflare tunnel URLs, published/Telegraph pages, dashboard links — as "exposed endpoints." The `api-endpoint` detector flags **every** URL (it cannot distinguish a call-target from a click-target), and the B5 prompt rule said to block when a URL was "handed to the user to call/**open**." A clickable share link is "handed to the user to open," so the authority blocked it. Reported by multiple agents on and off this machine. Files touched: `src/core/MessagingToneGate.ts` (B5 rule text + ALWAYS-ALLOWED line), `tests/unit/MessagingToneGate.test.ts` (5 prompt/plumbing tests), `tests/unit/GateSignalDetectors.test.ts` (1 detector-breadth test). The only decision point touched is the B5 authority instruction — a prompt-layer change that **relaxes** an over-tight gate; no new code path, no new blocking authority.

## Decision-point inventory

- `MessagingToneGate.buildPrompt` → B5_API_ENDPOINT rule (line ~807) — **modify** — narrow B5 to fire only on call-targets; explicitly pass open/click destinations; add worked examples both sides.
- `MessagingToneGate.buildPrompt` → ALWAYS ALLOWED section (line ~953) — **modify** — promote the vague "URLs the user can click to visit" to specifically name view/tunnel/published/dashboard/download links as never-block-under-B5.
- `GateSignalDetectors.detectApiEndpoint` — **pass-through** — unchanged; remains intentionally broad (a signal). Documented with a test, not modified.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

This change exists to **remove** an over-block, so it adds none. Before: any message containing a clickable view/tunnel/published link could be blocked under B5. After: those pass. The remaining B5 surface is narrower (call-targets only), so over-block strictly decreases. No new legitimate input is rejected.

---

## 2. Under-block

**What failure modes does this still miss?**

The risk in loosening B5 is letting a genuine "call this API yourself" instruction through. Mitigated: B5 still blocks a URL handed to the user to call (`curl http://…/commitments`, "hit POST /attention"), with a worked BLOCK example in the prompt and a test asserting that side. A truly adversarial framing — an API call disguised as "just open this" — could in principle pass, but (a) that is an agent-authored message, not untrusted user input, and (b) the same residual existed before for any call-target the model misread; this change does not widen it. The B1 (CLI command) rule still independently catches `curl …` presented as a command to run.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — exactly. The brittle detector (`detectApiEndpoint`) stays a cheap, broad SIGNAL that flags all URLs. The call-vs-open judgment requires intent and context, which is the AUTHORITY's job (the LLM with the full message). Putting the carve-out in the prompt (authority) rather than teaching the regex (detector) to recognize "view links" is the correct split — a regex trying to enumerate every share-link shape would be brittle and wrong. No higher gate should own this; no lower primitive is being re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — but the logic is a smart gate with full conversational context (LLM-backed).** The change lives entirely in the LLM authority's instructions. It adds **no** blocking authority and **reduces** existing false-positive blocking. The brittle detector is untouched and remains signal-only.

The fix makes the smart authority smarter; it does not push any judgment down into a brittle detector. Fully compliant — arguably the textbook application of the principle (resolve a false positive at the authority, leave the signal broad).

---

## 5. Interactions

- **Shadowing:** B5 sits beside B1–B7 in the same single-verdict prompt. Narrowing B5 cannot shadow another rule; a `curl`-style command is still caught by B1 (cli-command) independently. No shadow created or removed.
- **Double-fire:** none — one gate, one verdict per call. The `api-endpoint` signal still fires (unchanged); only the authority's use of it narrows.
- **Races:** none — pure prompt text + tests, no shared state, no lifecycle interaction.
- **Feedback loops:** none.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the machine: yes, positively — every agent's outbound gate stops blocking their share links once they update.
- Install base: ships as core server code in the next patch; reaches existing agents on update (see §Migration below).
- External systems: none. Response shape of `review()` is unchanged (same `{pass, rule, issue, suggestion}`); callers (telegram-reply.sh etc.) see identical structure.
- Persistent state: none.
- **Operator surface (Mobile-Complete):** no operator-facing actions added or touched. Not applicable.

---

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches only the gate prompt and unit tests; no dashboard renderer, approval page, or grant/secret form is involved.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — and identical on every machine.** The gate prompt is compiled server code shipped with the instar version; each machine runs its own gate over its own outbound messages. There is no per-machine state, no replication needed, and no divergence: every machine on the same version evaluates by the same rules. It emits no user-facing notices of its own (it only passes/holds a message the agent already authored, so one-voice gating is unaffected), holds no durable state (nothing to strand on topic transfer), and generates no URLs (it only *evaluates* URLs the agent wrote — and the fix specifically makes a cross-machine tunnel link survive the gate instead of being blocked). No single-machine assumption.

---

## 8. Rollback cost

**Pure code change — revert and ship a patch.** No persistent state, no data migration, no agent-state repair. Reverting the one commit restores the prior B5 wording exactly. During the rollback window the only "regression" is the original bug returning (share links blocked again) — no data loss, no corruption, no user-visible breakage beyond that.

**Migration Parity:** N/A for installed-file migration. The gate prompt is core server code (`src/core/MessagingToneGate.ts`), not an agent-installed template/hook/config/skill — so existing agents receive it through the normal version update, with no `PostUpdateMigrator` entry required. **Agent Awareness:** no CLAUDE.md template change — this is a behavior fix to an existing internal gate, not a new capability/endpoint/trigger.

---

## Conclusion

The review produced no design changes — the fix is a clean, minimal, authority-layer correction that strictly reduces false-positive blocking while preserving the genuine B5 block on call-targets, with tests locking both sides of the boundary. It is the textbook signal-vs-authority application (broad signal, smart authority). No persistent state, no migration, single-commit rollback. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** echo (dedicated reviewer subagent)
**Independent read of the artifact: concur**

Concur with the review. Audited against all five axes:
- **Under-block (central risk):** robust. B5 still fires on call-targets; the discriminator is intent not shape, with two worked BLOCK examples vs three PASS. The "API call disguised as open" residual is non-widening — it's agent-authored (not adversarial user input), B1_CLI_COMMAND still independently catches a literal `curl …`, and the pre-fix prompt already said "call/open" so any misread call-target passed before too. Net under-block surface does not increase.
- **Signal-vs-authority:** fully compliant — the diff is entirely inside `buildPrompt()` string literals (the LLM authority); `detectApiEndpoint` is untouched and stays broad, locked by the new detector-breadth test.
- **Prompt coherence:** no contradiction — "open a link in a browser" is cleanly outside the general ARTIFACT framing's act-on set (copy/paste/run/edit); the new B5 recasts an open/click URL as content, consistent top-to-bottom.
- **Test quality:** both sides covered; with the LLM mocked, asserting prompt content + verdict-plumbing is the correct deterministic guarantee and would catch the actual regression (dropping the carve-out / BLOCK example / call-vs-open language fails these).
- **Interactions:** nothing material missed. Non-blocking note: the `http://localhost:4040/dashboard` PASS example is correct for the *gate's* call-vs-open boundary; a separate pre-existing localhost guard governs the automated-send path independently (different layer). Accurate §5/§6 analysis.

Clean, minimal, authority-layer-only correction that strictly reduces false-positive blocking while preserving the genuine B5 block. Clear to ship.

---

## Evidence pointers

- `tests/unit/MessagingToneGate.test.ts` → `describe('B5 link carve-out (prompt teaches call-vs-open)')` — 5 tests: prompt teaches call-vs-open intent (not shape); names the exact click/open link classes; keeps a BLOCK worked example for a call-target; ALWAYS-ALLOWED names browser-open URLs; plumbing honors both verdicts (view link passes, curl target blocks).
- `tests/unit/GateSignalDetectors.test.ts` → "fires on click/open destinations too (intentionally broad)" — documents the detector's deliberate breadth.
- Live reproduction during this session: an attempted Telegram reply quoting `http://localhost:4042/foo` was blocked by the live (pre-fix) gate — the bug, observed first-hand.
- Local: `npx vitest run` on both files → 57 passed; `npm run build` → OK.
