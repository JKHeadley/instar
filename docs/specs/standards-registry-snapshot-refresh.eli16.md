# The tool that grades our rules was reading a copy that could never be updated — so we are deleting the copy

## What this actually is

We keep our standards — the rules the agent holds itself to — in one document. A tool grades
each rule: is it actually enforced by a real test, gate or linter, or is it just written down?

On 2026-07-25 that tool reported **4.55% enforced**. The real figure is **54.3%**.

The reason: the document has **81 rules**, and the tool was reading a copy with **22**. Not a
calculation error — a calculation over a quarter of its subject, with nothing on the screen
saying so. It was also blind to a rule we genuinely *do* enforce, because that rule sits under
a section heading the reader had never been told about.

## The diagnosis I got wrong first, which is the useful part

My first answer was: each agent keeps its own copy, the updater is too cautious to overwrite a
copy that looks edited, so a copy that drifts once is frozen forever. I wrote a fix that makes
that one file always get overwritten, wrote eight tests, and they all passed.

Then the review process asked a question I had not: *where exactly does the copy get refreshed
FROM, after the software is packaged?*

**It does not exist.** The list of files we publish does not include our documents folder. So
the source the updater copies from is absent on every ordinary installation. Which means:

- The updater has been failing to refresh that file on every ordinary agent since it was
  written. The copy was never frozen by caution — it was never reachable at all. **My root
  cause was wrong.**
- My fix would have quietly done nothing on every ordinary agent, hitting its own
  "nothing to copy from" branch by design.
- All eight of my tests passed while proving none of that, because they run on a machine that
  *does* have the source. **A green test suite over the wrong environment** — the same shape as
  everything else this project is about.

And the part worth recording: I had a note to myself, written days earlier, saying in almost
these words that our documents folder is unpublished and that a runtime check against a
document path is false on every installation. I did not apply my own lesson. An outside
reviewer found it in one pass.

## What we are doing instead

**Stop keeping a per-installation copy.** Ship the document as part of the package and have the
tool read it straight from there.

That is smaller than the fix it replaces, and it deletes the problem instead of maintaining it:
no copy to drift, no updater to repair, no "did the operator edit this?" question, no backups
to reason about. It also works out correctly in both worlds from a single rule — on an ordinary
installation it reads the shipped document, and on a developer machine the same rule lands on
the live source document, always current.

## The guardrails, in plain terms

Five rounds of review sharpened these considerably, and every one of them caught me making the
same *kind* of mistake the project is about:

- **"Is this document plausible?" cannot be a number I guess.** My first guard refused a
  document with zero rules. But the real bug was a document with twenty-two perfectly
  well-formed rules — my guard would have sailed straight past the only case that mattered. So
  the expected size and fingerprint are now **generated from the real document at build time**
  and compared. Any mismatch is a failure, not a tolerance.

- **A broken package must never quietly borrow the old copy.** If the shipped document were
  truncated, my first design fell back to the stale copy and reported a confident number over
  it — the exact behaviour being removed. Falling back now happens only when this code cannot
  locate its own files at all, and even then the result is explicitly marked *not verified*
  rather than presented as sound.

- **Check the package, not the packing list.** My verification plan asserted the document
  appears in our list of files to publish. A reviewer pointed out that the list is a *label*
  and the package is the *fact* — being listed is not being shipped. The check now builds a real
  package and looks inside it.

- **Old install and broken install look identical if you only check for a missing file.** A
  second shipped file tells them apart, so an old agent keeps working without that path
  becoming a hiding place for a packaging failure.

- **A generated file is not automatically a correct one.** "Generated, therefore it cannot
  drift" was too strong — a stale build directory or a wrong publish order breaks it. So the
  document, its fingerprint, and the actual package contents are checked against each other
  immediately before publishing, and the check **fails rather than repairing itself** — a check
  that quietly fixes things is the same silent-no-op wearing better clothes.

## How you will know it worked

Not by this document, and not by tests passing on my machine. By the live grading endpoint
reporting all **81** rules, marked as trustworthy, after this ships. That is written into the
completion conditions of the current work session, so it cannot be quietly skipped.

## The general lesson

**A file the program reads as an input should be read from the thing that ships it, not copied
into a per-installation file that then has to be maintained.** Copy-then-maintain needs an
updater, an "is it customised?" policy, a backup story and a drift detector — four mechanisms —
and in this case the copy was never even reachable. Reading from the package needs none of them.

And one about process rather than code: **a lesson in memory is not a mechanism.** My own note
said the documents folder is unpublished. It did not stop me. The fix that follows from that is
a check that fails when a runtime path points inside an unpublished folder — not another note.
