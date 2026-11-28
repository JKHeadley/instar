# Side-effects review: dev:profile-node refuses on darwin-arm64 without --force

## What changes
`instar dev:profile-node` (src/commands/devProfileNode.ts) checks the host before it signals the target. On darwin-arm64 it refuses with exit 1 and an explanation unless `--force` is given. Linux and Intel macOS are unchanged. `--force` restores the old behavior.

## Why
On Apple Silicon with SME2 (M4 and later), the V8 sampler's SIGPROF can land while onnxruntime runs SME2 matmul kernels, which the embedding model uses, and kill the target with SIGILL. Profiling a live agent server with embeddings on can take the server down. That was the reported problem.

## The trade-off (deliberately conservative)
The real hazard is narrower than "every macOS ARM host": it needs an SME2-capable chip (M4 or later) and a target that has onnxruntime loaded. The guard can't cheaply prove either from outside the target. Reading CPU features and the target's loaded libraries before profiling would add fragile, platform-specific probing to a diagnostic tool. So it refuses on all darwin-arm64 hosts:
- **False refusals:** an M1-M3 Mac, or a target without onnxruntime, is refused even though profiling would be safe. The cost is one `--force` flag, and the refusal message says when that's appropriate.
- **No false allows:** a vulnerable host is never profiled silently.

## The override
`--force` bypasses the guard for that run only. Nothing is persisted, and no config default changes.

## Side effects considered
- **Other commands:** none. The guard sits only at the start of runDevProfileNode.
- **Automation:** a script that profiled on Apple Silicon now gets exit 1 with a message; it must add `--force` to keep the old behavior.
- **Rollback:** revert the commit.

## Tests
tests/unit/devProfileNode.test.ts covers default refusal on darwin-arm64, forced use on darwin-arm64, and Linux running without the flag.
