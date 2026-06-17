---
title: Account Follow-Me
description: Seamless, ToS-safe cross-machine account and quota sharing.
---

Run one agent across several machines and have your subscription account work on every one of them — **log in once, and each machine re-mints its own login the ToS-safe way**. No Claude OAuth token is ever copied between machines (Anthropic's terms forbid relocating a Claude login out of its own store); instead each machine holds its own grant, exactly like logging the same account into a second laptop yourself.

This is **WS5.2 Account Follow-Me**. It ships dark on the fleet (live on a development agent for dogfooding) behind `multiMachine.accountFollowMe`. The security design lives in `docs/specs/ws52-account-follow-me-security.md`.

## What replicates (and what never does)

Only a **redacted, credential-free metadata projection** of each subscription account crosses machines — id, nickname, email, provider, framework, status, quota — so a peer machine knows an account's depth and quota *without holding its login*. The login location (`configHome`) and every credential field are stripped. This projection is the `subscription-account-meta` replicated journal kind, implemented in `SubscriptionAccountMetaReplicatedStore`. The `SubscriptionAccountMetaReplicatedStore` schema is a strict allow-list: any unknown or credential-shaped field is rejected on both the send and receive ends.

## The security primitives

Account Follow-Me is built on a set of hardened primitives, each proven before any live credential path exists:

- **`AccountCredentialShare`** — the dedicated `account-credential-share` mesh verb and its RBAC-gated handler. `AccountCredentialShare` runs the authorization gate (recipient match → operator mandate → single-use grant) *before* any decryption, and is structurally separate from the general secret-sync path so a credential can never ride the looser channel.
- **`CrossMachineMandate`** — the asymmetric Ed25519 issuance signature that lets one machine prove an authorization came from *your* operator machine. `CrossMachineMandate` is required because the existing mandate authorship proof is a machine-local HMAC that a peer cannot verify.
- **`PairingEpochManager`** — de-pair key rotation. `PairingEpochManager` rotates a machine's X25519 key when it is removed, which instantly makes every credential ever sealed to it undecryptable, and anchors the rotation generation in durable, rollback-resistant storage.
- **`AccountFollowMeGrants`** — single-use grants plus a per-account, sum-of-leases spend ceiling. `AccountFollowMeGrants` keeps a shared account from being over-drawn across machines and re-derives outstanding spend safely across a lease-holder failover.

## Authorization

Account Follow-Me is **operator-rooted**: a peer machine can never enroll an account onto itself. Authorization flows from a single PIN-gated coordination mandate, carried across machines by the `CrossMachineMandate` signature and enforced at the `AccountCredentialShare` gate. The metadata projection (`SubscriptionAccountMetaReplicatedStore`) carries no authority — it is reference data only.

## Status

PR1 ships the security primitives (`AccountCredentialShare`, `CrossMachineMandate`, `PairingEpochManager`, `AccountFollowMeGrants`) and the `SubscriptionAccountMetaReplicatedStore` metadata kind, with no live-credential code path. Subsequent rounds add per-machine enrollment, revocation, and the live proof.
