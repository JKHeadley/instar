# Test the real Codex Stop hook with a managed project worker

This change connects the packaged Codex Stop hook to the server's managed continuation path in a disposable test. That test starts a real Codex worker, enrolls it against an approved test action, and lets Codex finish a response. With the switch enabled, the worker receives one continuation. With it disabled, the worker stops after the first response.

Instar leaves the switch off by default. Regular project launches do not enroll workers or install a managed decision provider in this change. Existing task lists keep their normal request format and decision path. A tagged managed call that lacks a verified decision stops safely. Enabling live project work later will require the verified launch, ownership and receipt provider and an installed-hook update path.
