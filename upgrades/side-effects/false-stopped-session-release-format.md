# Side-effects review — stopped-session release-note format

This documentation-only change moves the stopped-session release fragment into the required `What Changed`, `Evidence`, `What to Tell Your User`, and `Summary of New Capabilities` sections. It does not change runtime behavior. The underlying runtime change has its own full review in `upgrades/side-effects/false-stopped-session-self-recovery.md`.

- Over-block: no user input or code path is blocked; the release assembler can now parse the fragment.
- Under-block: the note does not prove the live Slack canary or post-update Indra outcome, and says that plainly.
- Level of abstraction: release-note structure belongs in the fragment, while the behavioral review remains in the original artifact.
- Signal vs authority: no detector or blocking authority changed. The build gate reads structural headings only.
- Interactions: the new headings allow the existing release assembler and documentation checks to consume the text without changing their logic.
- External surface: users will see the same intended message after publication, in the standard release format. The note does not claim production proof.
- Multi-machine posture: documentation is published once with the release; no machine-local state is introduced.
- Rollback: revert this note and fragment edit; no migration or state repair is needed.

Second-pass review: not required for a formatting-only documentation correction. The preceding runtime artifact received independent concurrence.
