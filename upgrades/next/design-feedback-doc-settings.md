# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The design standard gains DS-WORDS-7: a document's settings block (the `name: value` lines between dashes at the top of a spec) is never rendered as its text, and a heading is built from one source line only. The owner feedback that earned it is recorded as DF-0007. Documentation only; the document renderer is unchanged.

## What to Tell Your User

Nothing changes on screen yet. The design standard now has a rule that a document starting with a settings block must display its own text, not the settings as a giant heading; the documents page will be fixed and checked against it.

## Summary of New Capabilities

None at runtime. A new design rule with an automatic check to build.
