# The model-routing rulebook, now proven and shipped in-repo — plain-English overview

Instar hands dozens of internal decisions to AI models: is this message an
emergency stop? Is this outgoing draft safe to send? May this autonomous run
stop now? Until now, WHICH model answered each question was set by sensible
defaults and one agent's living notes. This change ships that rulebook into
the repository itself, upgraded from opinion to evidence: every
recommendation now cites a benchmark run from INSTAR-Bench v2, which
stress-tested all of these decision-makers with thousands of hard cases
across fourteen different model routes.

The headline rules the benchmark earned: the biggest available model is NOT
the best pick for quick yes/no judgments — through one particular access
route it actually performs worst of the family, answering and then arguing
with itself (while WINNING the open-ended writing task, so the rule is "route
by the nature of the task," not by model size). Certain budget models are
banned from strict-format work because they think out loud past their answer.
One small model reproduced a live credential into a summary it wrote — so
digest-writing gets a hard safety note. And the cheap, subsidized routes that
DID prove accurate become the defaults, with ranked fallback chains when a
route is down.

The same change flips the benchmark-coverage ledger: every one of the 24
remaining internal AI decision-makers now either has a test battery (19 of
them) or a written argument for why testing it is meaningless (5 of them —
for example, one turned out to have no AI call of its own at all). The
build-time guard that refuses new AI decision-makers without benchmark
coverage now enforces the complete map, and expanding the exemption list
requires editing a pinned test — a visible, reviewable act. Nothing about
runtime behavior changes in this commit; it is the rulebook, the ledger, and
the guard's baseline catching up to what the benchmark proved. Rollback is
reverting one commit.
