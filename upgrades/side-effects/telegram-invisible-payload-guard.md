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
