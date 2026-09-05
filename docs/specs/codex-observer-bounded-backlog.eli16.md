# Codex observer bounded backlog — plain-language review

A busy Codex session can write more transcript data than the delivery observer is allowed to read in one pass. The observer used to treat that as corrupted whenever its fixed-size read stopped in the middle of the next line—even if many complete, valid lines came before it. Three real messages during the first release canary exposed this: the messages and replies were in the transcript, but their ledger rows became unknown.

The observer now saves progress through the last complete line and reads the unfinished line again on its next bounded pass. It still refuses a genuinely oversized single line, malformed JSON, unknown event shapes, or identity drift. Tests cover the exact busy-session shape at unit, integration, and production-wired E2E levels, and the certified candidate must repeat the full two-hour/50-delivery canary.
