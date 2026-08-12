# Side effects — the Telegram invisible-payload guard

This is the side-effects record for the guard as proposed for merge. The full window-10/11/12 record for
this line of work — every increment, every review, every repair — is carried on
`echo/window10-deep-property-guards` and is deliberately NOT part of this change, which is scoped to the
guard alone.

## Window 13 — the RichText walk becomes the grammar (pass 47 findings 2, 3, 4, 6)

**What changed.** `structuredTextLeaves` — a key-blind recursive descent that collected any string under
`text`/`expression`/`summary`/`html`/`markdown` anywhere in the structure — is replaced by
`structuredFieldScan`, which reads Telegram's `type` discriminator and descends only the fields that
variant declares. The table is transcribed from the Bot API server's own request parser
(`Client::get_rich_text`, `Client::get_input_page_block`, `Client::get_page_block_caption`,
`Client::get_page_block_table_cell`, `Client::get_input_rich_message`) rather than from the prose
reference, which truncated three times, or from my model of the API, which has an end date and was wrong
twice in one day.

The return type gains a third answer. It was `Leaf[]`, where an empty array meant both "this structure has
no text" and "I could not read this". Those are now separate: `{ leaves, undecidable }`.

**1. Over-block — what legitimate input does this reject that it should not?**

Strictly fewer than before, and one whole class is recovered. A media block, a map, a custom emoji or a
mathematical expression is now OPAQUE: it renders something this guard cannot inspect, so it suppresses
refusal rather than being absent from the leaf set. Before this distinction existed, a photo carrying a
zero-width caption produced `leaves = [invisible]` and was REFUSED — a valid message destroyed on the way
out. That case is now delivered and is pinned by test.

The remaining over-block risk is a variant this table does not know. An unrecognised discriminator
contributes nothing, so a message composed ONLY of unknown variants yields no leaves and is allowed — it
cannot be refused for being unreadable. The direction is deliberate.

**2. Under-block — what does this still miss?**

Named honestly, three:

- A `mathematical_expression` whose LaTeX renders nothing (a spacing-only expression) is allowed. Deciding
  it needs a LaTeX renderer. What changed is that it can no longer VOUCH for an otherwise-invisible
  message on the strength of its source characters, which was the actual defect pass 47 named.
- A `custom_emoji` is trusted to render. Its `custom_emoji_id` is not resolvable from here.
- The table is a snapshot of a live parser. If Telegram adds a variant carrying rendered text, this walk
  contributes nothing for it rather than mis-reading it — the safe direction, but not coverage. This is
  the same closed-world exposure the method table already carries and is why the method table refuses an
  unknown method at the door.

**3. Level-of-abstraction fit.** Unchanged and correct: it sits inside the single egress door, on the
serialised body, below every sender. Nothing above it is better placed to know the wire grammar.

**4. Signal vs authority.** This check HAS blocking authority, which is settled architecture for this
guard — it refuses only on a PROOF that every leaf is invisible, never on a heuristic. This change
strengthens compliance in both directions: it removes two ways for the check to claim visibility it had
not established (a member the server discards; a LaTeX source string), and it adds an explicit
"cannot decide" state so absence of evidence stops being treated as evidence. A guard that refuses on
what it could not read is precisely the brittle-authority shape the principle forbids.

**5. Interactions.** The unreadable-body waiver in `telegram-egress.ts` is unaffected — this operates on
a body that was read. The container change interacts with the method table: `sendRichMessage` and
`sendRichMessageDraft` declare `rich_message` only (the phantom `text` field was removed in the previous
commit), so no query field can waive the container walk. No double-fire: `structuredFieldScan` is called
once, by the post-format arm.

**6. External surfaces.** No route, config, message or state-file change. The only externally visible
difference is which outbound payloads are refused, and that moves toward delivering valid messages.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN. This is a pure function over one request body on
the machine performing the send. There is no state to replicate, no read to merge, no URL generated, and
no user-facing notice — so there is nothing for a second machine to hold a divergent copy of. Every
machine running this build applies the same table to its own egress.

**8. Rollback cost.** Low and self-contained: one file, one function boundary, no persisted state and no
migration. Reverting the commit restores the previous walk exactly. The failure mode of a bad rollback is
a return to the over-refusal (a valid photo message destroyed), not a leak.

**Proof.** The three new behavioural tests were run against the PREVIOUS walker before being kept, and all
three RED for the right reason: the discarded-member case allowed, the container-priority case allowed,
and the photo-with-invisible-caption case refused. The fourth new test — corrected wire discriminators —
passes on both walkers and is a fixture correction rather than a behaviour proof; it is recorded that way
rather than counted as one. 138 tests green across the six guard suites, full lint chain clean, type check
clean.

**Second pass.** Routed to the window's independent review lane rather than a local subagent: the next
reading runs on the other machine, on a different model, with an adversarial brief. That reviewer is a
stronger audit than a same-session one, and its verdict is archived with the branch either way.

No pass NUMBER is cited here, and that is the point rather than an omission. The first draft of this
paragraph named the reading that would audit it — a reading that had not run and whose verdict was
therefore not on disk. The archive guard refused the commit for exactly that: a citation is an obligation,
and reasoning from a reading nobody can read is uncheckable no matter how confident the sentence sounds.
Fourth time this guard has caught me in two days, and the first time it caught me citing the FUTURE.

### Window 13, second increment — the METHOD's field precedence

**What changed.** The reader-visible field list is now the method's own PRECEDENCE order, highest first
(`editMessageText: ['rich_message', 'text']`), and two consumers changed with it: the egress waiver
requires the query to supply the HIGHEST-precedence field, and the visibility check judges the ONE field
the method will actually read rather than every field present.

This closes a stated-open item rather than a new discovery, and it is the third instance today of one
shape: a set of alternatives that is really a priority union. The other two were the RichText variant's
declared fields and the rich-message container's arms.

**1. Over-block.** Reduced. An edit carrying a visible `rich_message` beside a leftover invisible `text`
was refused for content Telegram discards; it now delivers.

**2. Under-block.** Closed the live one: a visible `?text=` in the query beside an unreadable body waived
the refusal while the body was free to carry the `rich_message` that actually got sent. Remaining
exposure is the same closed-world exposure as everywhere else — a method whose precedence Telegram
changes, or a new multi-field method added without its order.

**3. Level of abstraction.** Unchanged; both consumers already sat at the door.

**4. Signal vs authority.** Strengthened. The waiver was granting an exemption on evidence that did not
bear on what would be sent. It now grants it only on the field that decides the outcome.

**5. Interactions.** The waiver and the visibility check were wrong in OPPOSITE directions on the same
fact, which is why they are fixed together — repairing one alone would have left the other's error in
place and looked complete.

**6. External surfaces.** None beyond which payloads are refused.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN, as above: a pure function over one request on the
sending machine, with no replicated state, no merged read, and no user-facing notice.

**8. Rollback.** Revert the commit; two small functions and one array order.

**Proof.** Both new tests verified RED against the previous rule before being kept. The table-pinning test
caught the reorder on its own and now pins the ORDER with its reason, so a future reordering fails there
first rather than silently reopening the bypass. 140 tests green across the six guard suites.

---

## The carve itself — scoping this change to the guard

**What changed.** Nothing in the code. This section records the decision to propose the guard ALONE
rather than the branch that produced it.

The working branch is 161 commits and 297 files. The guard is a small part of it: two new source files,
five call-site edits, one lint, five test suites, one spec. The rest is a review archive, a set of
decision records, and a body of constitutional work — an amended standards registry, new enforcement
ratchets, and their baselines.

**Why the split.** Two reasons, and the second is the one that decided it.

The stated scope for this increment is one clean item, with the constitutional rulings explicitly held
back. Proposing the branch would merge exactly the material that was held back, which is the opposite of
what was asked.

And the branch does not pass its own gate. The standards-coverage check refuses it: the Building and
Substrate family audits are stale against their amended content, and Building's reference-resolution
ratio falls below its floor because the amendment added articles faster than it added resolving
references. That is real, and it is real about the CONSTITUTIONAL work — the guard is not implicated. The
carve passes the same check unchanged, verified by running it rather than by reasoning about it.

**What it costs.** The guard's spec cites no review verdicts, so no archive is stranded by leaving it
behind. The constitutional work stays on its branch with its evidence intact and its gate failure
undisguised, which is where a decision that has not been ruled on belongs.

**1. Over-block / 2. Under-block.** Not applicable — no behavioural change from the carve. The guard's own
answers are in the sections above.

**3. Level of abstraction.** The carve is at the right boundary precisely because the lint proved it: the
first attempt left three setup-wizard call sites behind, `lint-telegram-egress-boundary` failed and named
all three, and they were brought in. The door's completeness is machine-checked, not judged.

**4. Signal vs authority.** Unchanged.

**5. Interactions.** The two branches now overlap on the guard's files. Whichever lands second will need a
rebase; the working branch is the one that must absorb it, and it is not proposed for merge.

**6. External surfaces.** None beyond the guard's own.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN, as recorded above.

**8. Rollback.** Revert the merge; the guard's files are self-contained and nothing persists state.

**Verified, not assumed:** main's full lint chain green on the carve (87 articles — main's registry,
untouched, which is the evidence the constitutional work did not come along), type check clean,
standards-coverage check PASSED where the full branch FAILED, boundary lint clean, 136 tests green.


---

### Window 13, third increment — pass 48's three findings

**What changed.** Three repairs, and one regression caught by my own negative control before it shipped.

**Finding 1 — the formula repair reached one of three representations.** OPAQUE treatment applied only to
the explicit `mathematical_expression` block, so the same formula written in the `markdown` or `html`
container arm still had its raw LaTeX SOURCE counted as visible content. Formula regions are now removed
from the visibility test in both arms, using the syntax the live reference gives (`$inline$`, `$$block$$`,
a ```math fence, `<tg-math>`). This is the fourth time this window that a repair was applied to one
spelling of its own class.

**The regression that nearly rode along, and how it was caught.** Removing formula regions and marking any
formula-bearing source undecidable would have ALLOWED an invisible payload wrapped in a formula tag — a
case the previous code refused. The blanket waiver was wrong; a formula grants it only when its own source
carries content. Then the first version of THAT check tested the whole matched region, so the delimiters
and the tag name supplied the content and every formula looked renderable. Both were caught by running the
negative control, not by reading the code.

**Finding 2 — a media declaration vouched without being referenced.** Mine, from one increment earlier: any
non-empty `media` array made the payload undecidable. The API defines that array as media *specified in*
the source via `tg://photo?id=` / `tg://video?id=` / `tg://audio?id=` links, so an entry nobody references
renders nothing. It now requires the pair — a declaration AND a reference to its id — or a direct
HTTP(S) media URL, which the reference says renders on its own. This recreated the discarded-member
defect one layer ABOVE the discriminator table, in the very increment that closed it below.

**Found while writing that control:** markdown image syntax left a bare `!` behind when the link was
reduced, and one visible-looking character is all this check needs to be talked out of a refusal. The
reduction now consumes the image marker.

**Finding 3 — `divider` was classified as rendering nothing.** It renders a rule (`<hr/>`). The runtime
outcome was the same either way, which is exactly why it mattered: the stated-open work of refusing a
structure PROVEN to render nothing depends on that distinction meaning what it says.

**1. Over-block.** Reduced twice: a media message whose source genuinely references its declared media is
no longer at risk from a stricter markdown reduction, and a real formula still delivers.

**2. Under-block.** Two closed (unreferenced media; the bare `!`). The declared residual is unchanged and
now honest across all three representations: a formula whose LaTeX renders nothing cannot be detected
here, and saying so in one arm while implying coverage in the others was the false claim.

**3. Level of abstraction.** Unchanged.

**4. Signal vs authority.** Strengthened. Two waivers that rested on unsupported inferences — media
presence, formula presence — now rest on checks against the documented grammar.

**5. Interactions.** The formula and media checks share one function and one source string; the media
check reads the ORIGINAL source, not the formula-stripped one, since a reference inside a formula region
would not be a rendered reference.

**6. External surfaces.** None beyond which payloads are refused.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN, as recorded above.

**8. Rollback.** Revert the commit; one function and two constant tables.

**Proof.** Both new behavioural tests verified RED against the pre-repair code. 142 tests green across the
six guard suites, type check clean.


---

## The lint that nothing was protecting

CI caught it on this branch, and it is this line of work's own systemic finding pointed back at itself: the
new boundary lint RAN in CI but was absent from the list that stops a merge silently dropping it — exactly
as its deleted predecessor had been, for that predecessor's entire life. Registered now, with the
replacement rather than after it.

That is the whole argument for the ratchet. The guard was real, it was running, and nothing guarded it.

---

### Window 13, fourth increment — two open items that lived only in the archive

**What changed.** Comments only; no behaviour. Two of pass 48's confirmed-open items — the body encoding
inferred from the JavaScript wrapper rather than `Content-Type`, and a self-hosted Bot API server being
invisible to both the runtime recogniser and the lint — were recorded nowhere in the source. They existed
only in review verdicts.

**Why it is worth a commit.** I had already written, in the merge proposal and in the release note, that
open items are named "in the SOURCE at the function that carries them, where the next reader meets them
rather than only in a document." That sentence was FALSE for two of ten when I wrote it. I checked the
claim by grepping the source for each item rather than trusting my own summary, which is the only reason
it surfaced — the same defect this window is named for, committed in the paragraph describing the fix for it.

Each is now recorded at the construct that carries it: the encoding limit at the collection function that
does the inferring, the local-server limit at the hard-coded host constant, each naming what closing it
requires so the next reader does not have to re-derive it.

**1–6.** No behavioural change; no over-block, under-block, abstraction, authority, interaction or external
surface effect. Comments.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN, unchanged.

**8. Rollback.** Revert; comments only.

**Proof.** 142 tests green across the six guard suites, type check clean, boundary lint clean.

---

## The silent-fallback ratchet, and why the baseline was not raised

CI refused this change at 498 designed fail-safes against a shrink-only baseline of 495. All three were
in the new egress door: two `new URL()` parses and two `decodeURIComponent` calls whose catch blocks
return a value rather than reporting a degradation.

**The baseline was not touched.** The file's own history shows the baseline raised five times, each with
a paragraph of justification, and each of those paragraphs is a small argument for why *this* change was
the exception. Raising it again for three catches I could instead explain would be exactly that move a
sixth time. The number only decreases from here, and it did not increase here.

Each catch is now tagged with the reason it is a fail-safe rather than a swallow:

- An unparseable URL is not a Bot API URL. `fetch` rejects it too, so classifying it as "not ours" is the
  accurate answer and there is no degraded delivery to report — the request never happens.
- A malformed percent-escape is judged in its RAW form rather than dropped. Refusing there would skip
  every check on a request Telegram still dispatches, which is the precise bypass shape this door exists
  to close. The fallback is toward MORE checking, not less.

**A detail worth recording, because it cost two runs.** The exemption marker must sit INSIDE the catch
block — the detector reads the block's own content. Two of my first three markers were written directly
above the `try`, read perfectly to a human, and did nothing. A marker that looks applied and is not is
the same shape as a test that looks like coverage and is not, which is what this whole line of work has
been about.

**1–6.** No behavioural change; comments and one catch reformatted from single-line to braced.

**7. Multi-machine posture.** MACHINE-LOCAL BY DESIGN, unchanged.

**8. Rollback.** Revert; comments only.

**Proof.** The ratchet reports 495 against a baseline of 495 — no net new fallbacks from this change.
146 tests green across seven suites, type check clean, boundary lint clean.

---

### Window 13, sixth increment — pass 49's three findings

**Finding 2 (the one that mattered).** The body-content test added for formulas in the markdown and html
arms was never applied to the explicit structured discriminators, which stayed unconditionally opaque. So
`$​$` written as markdown was refused while the identical formula written as a block or an inline wrapper
was allowed to vouch. **Fifth instance this window of a repair applied to one representation of its own
class** — and the repair is now a single `formulaScan` function used by all three, because a shared
definition is the only version of "swept" that cannot rot back apart.

**Finding 3.** The plain-language companion still described the deleted per-sender architecture as the
active safeguard, and still listed the single door as owed rather than shipped. Corrected, with what it
replaced recorded rather than silently overwritten, and the remaining debts restated as the narrow ones
that are actually true.

**Finding 1 — NOT closed, and the reason is on the record.** A formula whose source has characters but
renders no glyph still delivers. Deciding it needs a LaTeX renderer. What the repair does close is the
formula VOUCHING for the message around it, which is separable and now tested both ways.

**A residual I found while pinning finding 2, and pinned honestly rather than papered over.** A structure
whose ONLY content is an empty-bodied formula still delivers, because it yields no leaves and the no-leaf
rule allows. The walk cannot yet tell "understood, and renders nothing" from "not understood" — both
return the same state. My first version of the test asserted the refusal I WANTED; I corrected the test to
the behaviour that exists, because a red test written to a wish is a test I would later be tempted to
satisfy by weakening something real.

**1. Over-block.** Unchanged. **2. Under-block.** One closed (the structured formula vouching), two
declared. **3–6.** No abstraction, authority, interaction or external-surface change.
**7.** MACHINE-LOCAL BY DESIGN. **8.** Revert; one function and two call sites.

**Proof.** The new structured-formula tests verified RED against the pre-repair code. 147 tests green
across seven suites, type check clean, silent-fallback ratchet at 495 against 495.

---

### Window 13, seventh increment — a claim that had been false for two passes

**Found by reading the code against its own comment**, not by an external reading. The door's header said
it had stopped spreading `init` because object spread re-reads `body` — a second read of a
caller-controlled getter. The line below that paragraph still spread `init`.

**Why nothing caught it, which is the interesting part.** The outcome was safe: the spread's value was
immediately overwritten by the captured body, so the bytes on the wire were always the inspected ones.
Every test of the SENT payload passes either way. The defect was visible only by counting READS, and
nothing counted reads — so a false claim sat in the load-bearing paragraph of the load-bearing file for
two full passes, describing a repair that had not been made.

A second read is not harmless because its value is discarded: a getter with side effects runs twice, and
the next person to write `outgoing.body = x ?? init.body` inherits a hole the comment promised was shut.

The outgoing init is now built by copying every key EXCEPT `body`, so `init.body` is touched exactly once.
The new test counts reads rather than contents, and was verified to report 2 against the previous code.

**1. Over-block / 2. Under-block.** No change to any refusal decision.
**3-6.** No abstraction, authority, interaction or external-surface change.
**7.** MACHINE-LOCAL BY DESIGN. **8.** Revert; one loop.

**Proof.** Read-count test RED at 2 before, green at 1 after. 148 tests green across seven suites.

### Window 13, eighth increment — pass 50's single finding

**One new finding, down from three, on the same instrument** — so this decline is a comparable one.

**The finding is one I half-saw and shipped anyway.** The media reference check matched the bare
`tg://photo?id=<id>` URL ANYWHERE in the source rather than in a position that embeds. When writing it I
judged a plain substring match too weak BECAUSE an attacker controls the source and could plant the id
where nothing renders — then tightened it by one notch to a bare-URL regex and stopped. Tightening an
insufficient check reads like addressing the concern and is not the same as closing it: the attack I had
specifically imagined still worked against the tightened version.

A reference now counts only inside markdown image syntax or an HTML `src` attribute.

**Two corrections found by probing rather than by reasoning, and both matter.**

My first test for this asserted the wrong thing. I wrote a bare `tg://photo?id=x` in ordinary text and
expected a refusal — but that URL's own characters render, so the message is genuinely visible and
allowing it is correct. Probing the matcher directly gave the real cases: an id inside an HTML comment,
and an id inside an attribute that embeds nothing.

And the first version of the repair accepted ANY attribute, so `<a title="tg://photo?id=x">` — which
embeds nothing — still counted as a rendered photo. Narrowed to `src` after the probe showed it.

**1. Over-block.** Unchanged: genuinely embedded media still delivers, proven both markdown and html.
**2. Under-block.** Closed for the non-embedding positions. **3-6.** No other change.
**7.** MACHINE-LOCAL BY DESIGN. **8.** Revert; one pattern.

**Proof.** Verified RED against the pre-repair code. 148 tests green across seven suites (derived by running them, not recalled — the first draft of this line said 149).

### Window 13, ninth increment — a test that only worked on my machine

CI's shard 4 failed with "Claude CLI not found". The lifeline's constructor loads config, and config
refuses to load without an agent CLI present — so this suite passed on a developer machine and failed on
a runner. A test whose result depended on who ran it.

**The tempting repair was to skip the suite when no CLI is present.** That is the exact shape this line of
work exists to stop: a suite that reports green by not running is indistinguishable from one that ran, and
this suite covers the sender whose complete absence of a guard was the headline discovery of the whole
increment. Skipping it would have been coverage theatre in the highest-value place.

So the test SUPPLIES the prerequisite instead of dodging it: a stub binary inside a throwaway HOME, with
the detector's process-wide cache cleared so the stub is actually consulted rather than a stale null from
an earlier suite. Verified by probing the detector directly — it returns the stub path, so the mechanism
is load-bearing rather than decorative.

**1-6.** Test-only; no runtime change. **7.** MACHINE-LOCAL BY DESIGN. **8.** Revert; one setup block.

**Proof.** The detector probe returns the stub. 148 tests green across seven suites locally; the real
verification is CI, which is where the failure lived.

---

### Window 13, tenth increment — pass 51's two findings

**Two new, both PRECISION, no DESIGN.** The series on this instrument now reads 3, 1, 2 — low,
oscillating, and NOT converging to zero. Stated plainly rather than presented as progress.

**Finding 1 — a fact I already had and did not apply.** Rich Markdown may carry ARBITRARY HTML, and
Telegram parses those tags as Rich HTML. My Markdown reduction stripped link syntax and not tags, so tag
names and attributes counted as content and let a markdown source whose only rendered text is invisible
pass as visible. I read that sentence in the live reference EARLIER IN THIS SAME WINDOW, while deriving
the formula syntax from the same page. Having the fact is not the same as having used it — the window's
subject pointed at my reading rather than at my code.

**Finding 2 — a prefix match where an exact one was needed.** The embed pattern was
`id=<declared>[^)]*`, so a declared `pic1` vouched for a reference to `pic1EXTRA`, which names different,
undeclared media that renders nothing. The id must now END where the declared one ends — terminated by a
parameter separator, a quote, a closing paren, or end-of-input — and a following parameter still counts.

**1. Over-block.** Real text beside markup still delivers; an exact id with trailing parameters still
delivers. Both proven. **2. Under-block.** Both closed. **3-6.** No other change.
**7.** MACHINE-LOCAL BY DESIGN. **8.** Revert; one replace and two patterns.

**Proof.** Both verified RED against the pre-repair code. 150 tests green across seven suites.
