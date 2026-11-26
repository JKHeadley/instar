# Claude paste submission side effects

Tier 1. This changes one runtime file and adds fixture coverage of a reversible timing and pane-reading change. One design pass and zero commit attempts.

- **Over-block.** The marker reader can miss hidden or collapsed pasted text. It needs visible content to justify a recovery key. Opaque paste counters and the presence of an idle prompt alone do not identify this injection.
- **Under-block.** The one-second settle time is bounded. A slower TUI may still eat Enter. The existing recovery ladder checks the draft again and the persistent sentinel retains responsibility for later recovery. Two drafts with the same visible marker can still be indistinguishable.
- **Layer and authority.** SessionManager writes the paste boundary and owns the separate submit. Pane matching supplies evidence to the existing recovery path. It makes no provenance, admission or operator-action decision. See docs/signal-vs-authority.md.
- **Interactions.** The extra half-second is synchronous on confirmed Claude bracketed pastes. This can delay other requests on that worker. Single-line literal typing, unknown-framework and Codex submit timing take their existing paths. Recovery still checks for an active turn, session rotation and write refusal, and has a verify-only last pass. Notification callers still observe explicit refusal. Health continues to classify unsubmitted input as agent-owned.
- **External surfaces.** Fewer spurious keypresses and unsubmitted warnings are expected for answered turns. There is no API, configuration or data-format change. The controlled clock establishes behavior at one representative readiness time. It does not measure Claude in the field.
- **Multi-machine posture.** Each host reads and writes its local pane. The change introduces no durable state or cross-host action.
- **Rollback.** Revert the SessionManager change and its regression expectations. There is no migration or state repair.

The observed notification and queued-settlement callers also consume this matcher. Marker disappearance can resolve their result to `submitted`, including for a cross-machine reply. A collapsed paste, a changed Claude layout or a narrow wrap can therefore conceal a stranded draft. The final existing recovery rung sends two keys 150 ms apart without a capture between them. The initial Claude submit remains a single key. The pane read and keypress are separate tmux operations, so a concurrent edit can change the input between them.

The independent review identified that stripping indentation let a quoted ❯ in a different draft impersonate a prompt, and let a quoted ⏺ hide real input. Both cases failed in the fixture. The matcher now reads Claude role glyphs at the left edge and retains indentation on subsequent content rows.

A second fixture exposed an unpadded blank line between pasted paragraphs. The reader now consumes the blank row only when the marker expects a newline at that position.

The follow-up replaces duplicated framework identifiers with their shared constants. Both constants resolve to the same identifiers that the injection code compared before.
