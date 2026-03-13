# Playbook Data Flow Disclosure

> For developers integrating Playbook into their Instar agents. Required reading for GDPR/CCPA compliance.

## What Data Playbook Stores

| Data Type | Location | Content | Retention |
|-----------|----------|---------|-----------|
| Context items | `context-manifest.json` | Strategies, lessons, patterns the agent learns | Until retired by lifecycle or deleted |
| History log | `playbook-history.jsonl` | Append-only record of all changes | Indefinite (append-only) |
| Governance policy | `context-governance.json` | Decay rates, limits, thresholds | Manual updates only |
| Session scratchpads | `sessions/{id}/scratchpad.json` | Per-session working memory | Until session cleanup |
| Mount snapshots | `mounts/{name}/` | Read-only copies of external manifests | Until unmounted |
| User namespaces | `users/{id}/` | Per-user items and history | Until DSAR deletion |

## Where Data Lives

**Default**: All data is stored on the local filesystem under `.instar/playbook/`. Nothing is transmitted to any cloud service by default.

**When data leaves the machine**:
- **Reflector** (if enabled): Sends context items to an LLM API for quality analysis. Requires `ANTHROPIC_API_KEY`.
- **Eval-log** (if enabled): Sends session logs to an LLM API for evaluation. Requires `ANTHROPIC_API_KEY`.
- **Semantic dedup** (if enabled): Uses embedding API for similarity detection. Requires API key.

All LLM features are **opt-in** and disabled by default in `playbook-config.json`.

## PII Handling

PII screening is available as a feature flag (`features.pii_screening` in `playbook-config.json`). When enabled:
- Common PII patterns (emails, phone numbers, SSNs, credit cards) are detected before storage
- Items containing PII are flagged or rejected depending on configuration
- PII screening runs on imported items and mounted manifests

## Data Subject Rights (GDPR Article 17 / CCPA)

Three CLI commands support data subject access requests:

| Command | What It Does |
|---------|-------------|
| `instar playbook user-export USER_ID` | Exports all data associated with a user ID |
| `instar playbook user-delete USER_ID --confirm` | Permanently deletes all user data |
| `instar playbook user-audit USER_ID` | Shows audit trail of operations on user data |

### What `user-delete` removes:
1. All items in the global manifest with `user_id` matching
2. The entire user namespace directory (`users/{id}/`)
3. Session scratchpads associated with the user
4. Logs the deletion in the history (for compliance audit trail)

### What `user-delete` does NOT remove:
- History entries (append-only by design — the deletion event is logged but prior entries referencing the user remain as redacted references)
- Mount snapshots (external data, not user-owned)

### Crypto-shredding (Future — Phase 5)
The namespace model is designed to support per-user encryption keys. When implemented:
- Each user's data would be encrypted with a unique key
- `user-delete` would destroy the key, making data unrecoverable
- This provides cryptographic guarantees beyond filesystem deletion

Phase 4 (implemented as of v0.13.0) provides namespace isolation and DSAR tooling. Phase 5 adds encryption at rest.

## Retention Policy

Governed by `context-governance.json`:
- **Decay**: Items lose relevance over time based on `memory_type`-specific decay curves
- **Retirement**: Items below the confidence threshold are archived
- **Dedup**: Near-duplicate items are merged (reducing stored data)
- **Hard limits**: `max_items` and `max_tokens_total` prevent unbounded growth

## Third-Party Developer Responsibilities

If you build an agent using Playbook:
1. Inform your users that the agent accumulates context over sessions
2. Disclose if you enable LLM features (reflector, eval-log) that transmit data externally
3. Provide access to DSAR commands if your agent handles personal data
4. Configure appropriate retention policies in governance
5. Consider enabling PII screening for user-facing agents
