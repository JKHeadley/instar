# Pull-request hints now explain the right section

The repository’s pull-request template recently gained two required sections:
ELI16 and UX Impact. It also included a short comment explaining what each
automated gate checks.

The comments were placed one section too early. The ELI16 length hint sat above
the ELI16 heading, while the UX hint sat above the UX heading. In the editor,
that made the guidance look like it belonged to the preceding section. An
author filling out UX Impact could miss the requirement to quote an exact string
from the diff even though the template contained those words elsewhere.

Each comment now sits directly below its own heading. The test no longer proves
only that both headings and both hints exist; it extracts each section and
asserts that the correct hint opens that section. Moving a hint back to the old
position makes the test fail.
