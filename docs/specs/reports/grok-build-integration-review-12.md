# Convergence round 17 — the heaviest round of the seventeen

Six internal reviewers plus the external cross-model pass (`codex-cli:gpt-5.5`,
verdict SERIOUS ISSUES). Roughly 25 findings. Unlike rounds 13-16, most of these
are defects in SHIPPED CODE rather than spec text, and three were live on the
operator's machines when the round started.

The round's shape, stated plainly: **the last four rounds each found most of
their defects in the previous round's fixes, and round 17 continued that — two
of its findings are holes opened by round 16's own impersonation fence.** That
pattern is the reason the code freeze between rounds exists, and it has not yet
produced a quiet round.

## Security / safety defects fixed (confirmed by execution, not reading)

1. **`.instar/config.json` was write-fenced and freely READABLE.** Round-13
   fenced it against edits because it selects which executable a session
   spawns; the read half was never closed, so the same Bearer token could GET
   it and read `dashboardPin` and `authToken` verbatim — reopening every
   PIN-gated lever the fence protected. Confirmed end-to-end against the real
   router. Fixed by moving it to the never-SERVED list, which closes read,
   download, link, list and edit in one entry.

2. **A grok-only agent booted with NO IntelligenceProvider at all.** The
   claude-forbidden guard fires on `enabledFrameworks: ['grok-build']`, the
   grok provider returns null BY DESIGN (§6.1), and the fallback hard-coded
   claude-code — which then threw into an empty catch. The observable result on
   Groky: the outbound tone gate, an always-on safety floor everywhere else,
   silently inactive, reported as "no Claude CLI available" on a machine where
   Claude IS installed. A wrong diagnosis is worse than a missing one. Fixed
   with a real fallback ladder (other enabled frameworks first, claude-code
   only when not forbidden) and an honest reason when none can be built.

3. **The impersonation fence had a fifth site — the triage spawner.** It read
   raw `config.claudePath`, which on a grok-primary agent IS the grok binary,
   and would have run grok with Claude Code argv and an unscrubbed `XAI_API_KEY`.
   Same class as rounds 14/15/16, one caller over. Fixed, plus `XAI_API_KEY` and
   `GROK_DEPLOYMENT_KEY` added to that pane's env scrub.

4. **The internal-provider fallback had the same shape** and would have spawned
   grok with `-p <prompt>` — the full prompt IN ARGV, which is precisely the
   leak the adapter's `--prompt-file` transport exists to prevent, with no
   confinement floor, no scratch cwd, no budget ledger and no metered-key
   refusal. Fenced.

5. **Two "binary present" gates were dead code.** `resolveGrokBinaryPath` is
   TOTAL, so `if (!grokPath)` could never fire: an operator who enabled
   grok-build without installing the CLI got a green "registered" line instead
   of the install prompt. This is round-11's fix inverted — routing every caller
   through one canonical resolver was right and silently removed the resolver's
   ability to report absence. Fixed with a shared tri-state
   `frameworkBinaryExists`, where only an explicit `false` refuses (a prober
   failure must never become an outage).

6. **The second interactive opt-in was Bearer-patchable.** `enabledFrameworks`
   is not API-writable, but `sessions.grokInteractiveSessions` sat under a
   patchable key, so one PATCH durably opened tool-enabled interactive grok
   sessions — the exact outcome the second gate exists to prevent. Added to the
   operator-only fence.

7. **Confinement was open-by-default.** Measured against grok 1.0.4: flag NAMES
   are validated (an unknown flag exits 2, so a vendor renaming a safety flag
   fails the spawn closed in the argument parser — a stronger guarantee than
   the spec claimed), but flag VALUES are NOT (`--disallowed-tools
   bogus_tool_xyz` exits 0 silently). So a deny list silently stops denying a
   renamed tool. The live lane now passes an EMPTY ALLOW LIST as the primary
   bound, with the deny list retained as defence in depth — the reviewer needs
   no tool at all, and naming zero permitted tools cannot be drifted by any
   rename or addition. Verified on a real call before landing.

## Structural defects fixed

8. **The drift canary covered 3 of 5 frameworks and could not fail.** Its array
   was annotated in a way that PERMITS a subset, and both self-guards were
   inert — one a tautology over an array derived from the list under test, the
   other a `never` check in a file `tsc` never sees, since tsconfig excludes
   `tests/`. Derived from the canonical list instead. **Widening it immediately
   found a real defect:** `pi-cli` fell through to the CLAUDE transcript path —
   the exact defect round 11 fixed for grok, never swept to its neighbour. Both
   now return honestly, and the switch is exhaustive so the next framework
   cannot inherit the Claude layout by omission.

9. **A grok-primary agent installed with NO instruction file.** CLAUDE.md is
   gated on claude being enabled and there was no shadow-file entry for grok, so
   the §10 awareness note reached every agent EXCEPT the ones this spec exists
   to create — and the migrator could not repair it, since it early-returns when
   the file is absent. Fixed for grok-build and for pi-cli, which had the same
   inherited hole.

10. **A stale framework set collapsed grok's route identity.** An agent
    switching its default to grok-build inherited the prior route's durable
    breaker state. Derived from the canonical list; same fix applied to the
    router's known-framework set.

11. **The pin-fallback notice named the wrong cause.** On the documented
    reviewer posture the CLI IS launchable and the real refusal is the
    interactive opt-in — so the operator was handed a remedy (install/repair the
    binary) that cannot fix their problem, while the real remedy is a key the
    message never named. The two causes now have distinct reasons and distinct
    remedies. The test that should have caught it asserted only that the notice
    contained the framework name, which the interpolated pin satisfies
    regardless of the sentence.

12. **`claude-code` was an UNCONDITIONAL last-resort candidate**, so the
    normative contract's "runs on an ENABLED framework" was false on this
    spec's own deliverable shape: a grok-only agent's job spawns landed on the
    Claude account — a billing consequence chosen by a fallback rather than by
    the operator. Now conditional, with a control pinning that agents with no
    configured list keep working.

## Spec corrections

13. The precedence rule was INVERTED. The normative contract said "where it and
    a later section disagree, the later section governs" — making a
    read-this-first extract yield to text the reader would then have to read
    anyway, so it bought nothing. It now GOVERNS, and a disagreement is a defect
    to fix rather than a conflict resolved by ordering.

14. §0.5 rejected the API path on economics while §0.0 says the billing sink is
    unknown. Re-grounded on independence, local token caps, and the operator's
    actual goal — and round 17 further separated the PHASE A case from the
    PHASE B one, because they do not have the same answer: for a reviewer alone
    an API path would serve, and what justifies the CLI is that only it can
    deliver an agent that RUNS on grok. Phase A's door is chosen by Phase B's
    requirement, and the spec now says so rather than selling a Phase-A argument
    for a Phase-B decision.

15. The operator-facing ELI16 companion still carried the economics claim round
    16 removed, in its literal "What you're deciding" section — and the gate
    over it only checks the file exists and is long enough, so it can never
    catch that. Reconciled by hand; the reconciliation step is a real gap in the
    convergence loop, not something the gate will ever supply.

16. §10 became a CONTENT CONTRACT rather than a topic list. It named four items;
    two other DECIDED things lived nowhere but the shipped string and both
    drifted. The two that drifted are exactly the two with no §10 entry — the
    correlation is the mechanism.

17. Two more deferral-carrier defects (instances 5, 6 and 7 of a class now
    seven-strong), and an honest downgrade: **the marker table is not "the
    structural fix" it was called.** The gate over these markers is a REGEX —
    verified by running it, a nonexistent id, a garbage token and a
    wrong-but-real carrier all PASS. The table plus round-16's inlined excerpts
    make a defect FINDABLE by a careful reader, which is how these were found;
    the ENFORCING gate is still owed.

18. Invariant 5's cross-fleet surface list grows from four to six, and two of
    the additions were introduced by this branch's own fixes: round-16's fence
    changed codex/gemini binary resolution for every agent (correct direction —
    reverting restores an impersonation — but not invisible), and the orphan
    reaper now recognises `grok` processes fleet-wide (digest only; kills stay
    tmux-ownership-gated). The claim that the original four are "each named in
    §11" was also false — §11 names two — now stated accurately.

## Round verdict

Round 17 produced roughly 18 DESIGN-class findings. **The convergence counter
restarts.** Two consecutive zero-DESIGN rounds are still required, and after
seventeen rounds this document has not yet produced one.

---

## Late round-17 findings — from actually driving the mentee cycle

Everything above came from reviewers reading the branch. These came from giving
Groky a real task, which is a different instrument and found a worse defect.

19. **The only live lane did not work.** Grok's `--output-format json` envelope
    embeds RAW newlines inside its JSON string values — measured on a real
    reviewer-shaped run: 109 raw, 0 escaped, strict parse failing at char 205.
    `parseGrokEnvelope` returned null for the real payload while parsing a
    single-line control fine. Repaired (a string-aware control-character
    escape that leaves valid JSON byte-identical), with both shapes asserted
    and the fix verified failing when reverted.

    **Why it survived a live proof, which is the finding that generalises:**
    the earlier end-to-end verification asked grok to "Reply with exactly: OK".
    A one-line envelope contains no raw newline, parses cleanly, and certifies
    nothing about the shape the lane carries. Running against a REAL binary,
    with real tokens and a real envelope, did not rescue it — the input shape
    WAS the defect. A live proof whose input is narrower than production is
    exactly as blind as a unit test that cannot fail, and "we tested it for
    real" is a property of the CASE, not of the binary.

20. **Three matrix corrections from the mentee, who runs on grok.** Asked what
    an outside observer would get wrong about his own framework's stall matrix:
    (a) `wedged-context` was Claude's failure shape mapped onto a grok one-shot
    abort — from inside the turn is GONE, not stuck; (b) a class he actually
    hits was absent entirely — an in-flight tool hang, process UP and blocked on
    a tool result that never returns, which no enumerated class covered because
    it is only visible from inside a turn; (c) `stopReason: cancelled` is NOT
    runtime-observable — it lives on one HTTP response, never the pane,
    transcript, or ACP updates, so it must never be written into a detector.
    All three applied. The missing class was added to the CANONICAL taxonomy
    (it is framework-agnostic) and a row added to all five framework matrices;
    all five validate.

21. **A false retraction, corrected.** I reported that Groky's apprenticeship
    instance had zero recorded cycles, based on the instance record's inline
    `cycles: []`. Cycles live in a separate collection; querying it showed the
    cycle present and correctly typed. The original claim was right and the
    RETRACTION was the error — scope a negative to the store actually queried.
    Recorded here rather than quietly fixed, because a wrong retraction spends
    the same trust as a wrong claim.

22. **The keystone axis is honestly blocked, not missing.** Both cycles are
    recorded on the keystone `mentor-mentee-differential` kind but with channel
    `direct-shortcut`, which the registry deliberately excludes from the
    keystone count — correctly, since nothing was visible from a human's seat.
    A keystone-counting cycle requires Groky's real user channel, which is the
    operator decision already filed (CMT-1322). The registry's refusal to count
    a CLI-driven cycle is the Live-User-Channel Proof standard working, and was
    not worked around.
