# Ratifying five amendments to the multi-machine standard — Plain-English Overview

## The problem in one breath

The rulebook said an agent's features should work across all its machines, and let a feature opt out by picking one of three excuses. On 2026-08-21 the operator found that the rule, as written, still permitted a design where some of what the agent knows lives on only one machine — and that one of the three excuses was being used for credentials that merely *happened* to sit on one disk. He approved five changes on 2026-08-22. This is those five changes written into the rulebook, plus machinery for the two of them a program can actually check.

## What already exists

*An Instar Agent Is Always a Multi-Machine Entity* is the single governing article for how a feature declares where its state lives. A feature declares `unified`, `proxied-on-read`, or `machine-local` with a reason drawn from a closed list of three: a credential physically tied to one machine, a hardware-bound resource, or an exception the operator ratified. A report-only script, `scripts/lint-machine-local-justification.js`, parses those declarations out of specs and reports the malformed ones. It blocks nothing; a human reviewer holds the judgment about whether a stated reason is actually true.

## What this adds

**1 — Single-machine survivability.** If every other machine disappears, the agent loses resources but never information. This is stronger than the test the article used before: a design that fetches data from a peer on demand passes "can this be unified?" while failing this, because it depends on that peer being up. That is exactly the gap the conversation-history design fell into, surviving six review rounds before the operator caught it.

**2 — Say what must be true, not how to store it.** The rule now states an outcome — any machine can act coherently on anything the agent knows — instead of mandating that every byte sits on every disk. Several storage designs satisfy it; fetch-from-a-live-peer does not. A better mechanism can be adopted later without amending the constitution.

**3 — The credential excuse is narrowed.** `physical-credential-locality` now covers only a credential whose relocation is genuinely prohibited — a vendor's terms, a hardware-bound key, a legal residency rule. The declaration must name who forbids the move and say whether that is permanent or temporary. A credential a vault could hold is a storage choice, and this excuse no longer covers it.

**4 — Archiving may compress, never delete.** This became its own rule rather than part of the multi-machine one, because it is true of an agent on a single machine with no peers at all. It governs *memory* — conversations, learnings, relationships, knowledge — and deliberately does not govern logs, metrics, or audit trails, which are supposed to be trimmed. Without that boundary it would contradict an existing rule requiring audit trails to age out, and each could be cited against the other. The single permitted deletion is one the operator asks for.

**5 — A label for "on the way."** A new fourth excuse, `migrating-to-unified`, for a surface whose correct posture is unified but whose machinery is not built. It must cite the decision that made unified the destination, link the work that delivers it, and carry an expiry date.

## The new pieces

Change 5 exists because of change 1, and this is the one dependency among the five. Making survivability the test converts a population of currently-passing `machine-local` surfaces into surfaces whose correct posture is unified and whose mechanism is unbuilt — with only three excuses available, the honest label does not exist. The conversation-history design already hit this: nine of its surfaces were labelled "operator ratified this" for a ratification the operator then refused. So adopting 1 without 5 would manufacture exactly the false labelling the list of excuses exists to prevent.

## The safeguards

**Two of the five are machine-checked; three are not, and the rulebook says so.** Changes 3 and 5 reduce to checks the parser already performs, so they are enforced on arrival. Changes 1, 2 and 4 cannot be — no program can decide whether a design survives losing its peers — so they are recorded as unenforced obligations with dated countdowns rather than given a guard they do not have. Naming a guard that measures something else is how an article comes to read as protected while protecting nothing; the registry already carries one article's worth of scar tissue about exactly that, and this change refuses to repeat it inside the article being amended for honesty.

**The new key cannot become a permanent hiding place.** It requires a date and a tracked delivery, and an expiry that has passed is itself a reported finding. That is the only reason a fourth excuse was acceptable in a list kept deliberately short.

**Nothing here blocks anyone.** The parser reports and exits zero. Narrowing the credential excuse moved the report count from 73 findings to 122 across the spec corpus — 19 declarations that never named who forbids the move, and 11 surfaces thereby left undefended. That number going up is the amendment working.

## What ships when

The rulebook text and the two enforced contracts ship together, so the prose and the parser cannot disagree. Fixing the 19 newly-reported declarations is separate work and is not folded in here.

## What you actually need to decide

Nothing further about the five — all five were approved on 2026-08-22 and this is their application. One thing does need the operator, and it is not a judgment call: a guard landed on 2026-08-17 requiring every constitutional change to carry an independently signed ratification, and the key it verifies against shipped empty. No rulebook change has landed since. This one cannot either until that key is installed in protected main. The private key is deliberately meant to live where no agent can reach it, so that step is the operator's alone.
