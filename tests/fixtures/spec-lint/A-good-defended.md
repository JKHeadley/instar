---
title: "Fixture — defended machine-local surface (PASSES Standard A)"
---

# Fixture spec — a well-defended machine-local surface

This surface stores the Telegram bot token binding, which physically lives on one
disk's keychain.

## Multi-machine posture

The bot-token → forum/topic-id binding is machine-local: it is namespaced by the
per-disk service credential and cannot be replicated safely.

machine-local-justification: physical-credential-locality
