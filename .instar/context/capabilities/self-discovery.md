# Self-Discovery

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities
```

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, git sync status, relationships, and more. This is the source of truth about what you can do — not prose descriptions in documentation files.

## Critical Rule

If documentation says a feature is "for standalone agents" or "when configured" or uses any qualifier — do NOT conclude you lack the feature. Check `/capabilities` instead. Documentation describes features in general; the API tells you what's actually running for YOU right now. When they conflict, the API wins.
