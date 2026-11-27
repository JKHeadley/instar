# Each unsorted health problem says what it is about — plain-English overview

**What this is.** The health screens on the phone and the dashboard list problems the agent noticed. Each problem the project has already written a description for gets a clear title. Every other problem got the same title: "Something inside me used a backup path". On 2026-11-06 Justin saw two of these, thought they were duplicates, and then noticed their details were different and full of internal words such as "verifyInjection", "sentinel" and "tick".

**What changes.** Every problem without a written description now gets its own title, picked in this order:

1. If the part of the agent that reported it is one of about 35 well-known parts, it gets a fixed, plain title. The feedback-fix runner reads "Feedback fixes are waiting". The stuck-message helper reads "I pressed Enter for a stuck session".
2. Otherwise, if the part described its own impact in a short, plain sentence, that sentence becomes the title.
3. Otherwise, the title names the part in plain words, such as "Something in my background sync used a backup path".

If two different problems would still end up with the same title, the second one gets a short tag so they never look identical.

The "in the agent's words" details get the same care:
- The repetitive "Using … in the meantime — everything else is working fine" ending is removed.
- Well-known parts get a plain sentence instead of their internal one.
- Anything that still contains code-like names is left out rather than shown.

**What stays the same.** The line "I haven't sorted this one yet, so I can't say whether it affects you" still appears, and Ask still works. Problems that already had a written description look exactly as before. Nothing about what is counted, hidden or blocked changes; this only changes the words.

**Safeguards.** It is all fixed rules, with no AI model involved, so the same problem always gets the same title. Secrets and file paths are removed before the plain-words check, as before.

**What you need to decide.** Nothing. It is a small, reversible wording change.
