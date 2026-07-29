# Keyword gates now distinguish an enum value from a prose decision

The development gate that checks technical specifications for unfinished work
used to read every occurrence of the word “deferred” as a decision to postpone
something. That is usually a useful warning, but it also caught a telemetry
value such as `deferred-in-flight`. The value names a state in software; it does
not say that implementation work is being postponed. Because the check blocks a
commit, the only escape was an audited override even though there was no work to
track.

This change adds one deliberately narrow distinction. It knows the actual
closed list of migration telemetry outcomes shipped by the code. A match is
treated as an enum reference only when the complete inline-code value belongs
to that list and at least one other member of the same closed list appears in
inline code on the same line. A lone `deferred-in-flight` still triggers the
gate because it could be an authorial status. The exact same words in ordinary
prose also trigger it, as do headings, blockquotes, callouts, indented list
text, fenced blocks, standalone `deferred`, unknown identifiers, and escaped
backticks. Those places can all carry genuine scope decisions, so the
implementation does not infer intent from Markdown or hyphen count.

The new parser preserves the existing tracker lookup, diagnostics, override,
and block behavior. It supports matching single- or multi-backtick inline-code
spans, refuses fenced blocks and malformed ranges, and has a parity test that
pins its local closed set to the shipped type declaration. Tests prove both
sides: the telemetry enum list passes, while real scope-decision forms remain
blocked. A mutation test removed the new distinction and the enum regression
failed immediately.

The same investigation also records the broader failure class in the defect
registry: a literal keyword is given authority without enough context to know
what it means. That class remains unconfirmed and open because the other named
systems do not share one safe mechanical fix. The outbound convergence check is
separately tracked for removal from blocking authority; the recall change is
owned elsewhere; and raw shell-input safety needs enforcement at the relay
boundary, not another text carve-out. This PR therefore fixes the live enum
false positive without pretending it closes those different problems.
