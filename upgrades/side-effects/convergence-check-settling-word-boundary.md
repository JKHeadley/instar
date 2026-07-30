# Side-effects review — SETTLING rule word boundary

**Change.** The pre-messaging quality gate's SETTLING rule contained the fragment
`there (is|are) no` with no trailing boundary. It matched inside longer words that
merely begin with "no" — `nothing`, `none`, `nobody` — so ordinary descriptive
English was blocked as if the agent were settling for an empty search result. The
fragment is now `there (is|are) no([^a-zA-Z]|$)`, using the same guard idiom the
adjacent commitment rule already applied to `promise`.

**How it was found.** A second session of this agent, running on the Laptop, had a
correct message blocked twice on the phrase "there is nothing pathological
required" and reported it rather than working around it.

**The defect was larger than the one character.** The identical regex lives in
THREE places: the shell template, its TypeScript port (`ConvergenceChecker.ts`),
and an inline fallback in `PostUpdateMigrator` used when the template cannot be
loaded. All three are fixed, and a drift guard now asserts they stay identical.
Fixing only the template would have left the port broken and shipped the bug to
any agent whose template load failed.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

This change **removes** over-blocking; it adds none. Three realistic sentences that
were blocked now pass, each verified against the unfixed source first:
"There is nothing pathological required." / "I checked and there are none of those
left." / "There is nobody else on that machine."

## 2. Under-block — what failure modes does this still miss?

The rule now misses `there is no<word>` constructions where the longer word really
is a settling claim. I could not construct a realistic one — "nothing", "none" and
"nobody" are the only common continuations, and the genuinely-settling forms among
them ("there is nothing to report") are caught by a **different** alternative in the
same rule, `nothing (to report|happened|was found)`. That is asserted explicitly by
test rather than assumed, because it is the whole reason this narrowing is safe.

More broadly, the SETTLING rule remains a heuristic keyword matcher and always was.
This change does not make it smarter, only less wrong on one fragment.

## 3. Level-of-abstraction fit

Correct layer. The bug is in the pattern itself, not in the hook that invokes it or
the gate that consumes the verdict. No caller changes. The deeper question — whether
a keyword matcher should hold blocking authority at all — is a real one but is out
of scope here and is not made worse by this change.

## 4. Signal vs authority compliance

This gate **does** hold blocking authority with brittle logic, which is in tension
with `docs/signal-vs-authority.md`. That tension pre-exists this change and is
unchanged by it: the fix strictly narrows a false-positive branch, so it moves the
brittle authority in the safer direction (fewer wrong blocks) without expanding what
the check can block. No new authority is introduced, and no rule gains reach.

## 5. Interactions

None found. The fragment is one alternative inside one alternation in one rule. The
other six rule categories are untouched. The one interaction that matters is
intra-rule and is deliberate: `nothing (to report|...)` still catches the true
positive the narrowed fragment gives up, so the two alternatives now divide the work
cleanly instead of overlapping.

## 6. External surfaces

Agent-facing only. No end user sees this gate. Agents will see strictly fewer
spurious "MESSAGE BLOCKED" refusals on outbound messaging. No API, config key, or
schema changes. No timing or conversation-state dependence.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so** — no `machine-local-justification`
marker is required because this introduces no new state or feature surface. The
script is a per-machine installed file, already written to every machine by the
existing always-overwrite migration path
(`PostUpdateMigrator` writes `scripts/convergence-check.sh` unconditionally). Each
machine therefore converges on the fixed copy independently at its next update;
there is nothing to replicate, merge, or proxy. Migration parity was **verified, not
assumed**: the write at `PostUpdateMigrator.ts:9943` is unconditional, and the
template and the installed copy were confirmed byte-identical before editing.

Note the asymmetry this creates in the interim: the Laptop, which reported the bug,
keeps the broken copy until it updates. That is the normal update lag, not a
coherence defect.

## 8. Rollback cost

Trivial. Revert one commit; the migration overwrites the script back to the previous
content on the next update. No data migration, no state repair, no agent-side
cleanup. The change is additive to a regex and carries no persisted footprint.

---

## Testing

22 unit tests. Run against the **unfixed** source first: **12 failed / 10 passed**
there, so 12 assertions genuinely discriminate (6 false-positive cases + 6 drift-guard
assertions) and the other 10 are labelled CONTROL in the file because they pass either
way and are not evidence for this change.

The drift guard is the structural half: without it, the next person fixes one copy of
three and the bug survives in the other two exactly as it did here.
