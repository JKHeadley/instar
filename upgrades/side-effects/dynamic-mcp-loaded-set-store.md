# Side-effects review — dynamic-MCP loaded-set state store

**Change:** New `src/core/McpLoadedSetStore.ts` — durable per-topic "which MCP
servers is this session running with" state, with two-phase commit + atomic writes.
7 unit tests.

## 1. Blast radius
Zero at runtime. No importer yet — the spawn builder and driver wire it in a later
commit (behind the dark flag). `buildSessionMcpFlags` currently inlines an
equivalent read; the composition commit will route both through this store.

## 2. Reversibility
Fully reversible — delete the file + tests. No migration; the on-disk JSON it would
write is inert when the feature is off.

## 3. State / data touched
Writes `<dir>/<topicId>.json` ONLY when its `write` is called (by the driver/spawn
builder in a later commit). Atomic temp+rename. Holds no secrets — just server
NAMES + a committed flag + timestamp.

## 4. Failure modes
`read`/`readCommitted` return null on absent/unreadable/torn files (never throw);
`exists` lets the caller distinguish absent from unreadable (drives the M6 fail-to-
lean decision). `write` throws on a genuine fs failure so the driver can roll back —
the driver is responsible for fail-safety. The two-phase contract (un-committed is
invisible to the reader) is the M1/M3 fix.

## 5. Security / authority
None. No authority; just state IO of server names.

## 6. Framework generality
Not applicable — framework-neutral state file; no launch/inject surface.

## 7. Tests
7 unit tests: absent ⇒ nulls; committed write readable; un-committed exists-but-
readCommitted-null (M1/M3); commit-after-in-flight; de-dup; torn file ⇒ read-null-
exists-true; no leftover .tmp (atomic). tsc clean.
