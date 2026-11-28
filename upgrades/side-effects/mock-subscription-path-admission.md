# Subscription routing tests and host admission accounting

## Scope and evidence

The five unit cases in the subscription path fixture use a mock for child command execution and an in-process substitute for the pool. The real factory wraps these paths with its normal spawn semaphore. Before this change, the singleton constructed its storage path from the operator’s home. Source inspection established the coupling. The recent failed-file journal named other files and provides no evidence that this fixture caused those failures.

## Effects

Each case scopes the home-directory lookup to its own temporary directory, resets admission and circuit-breaker state, and checks the exact ledger path before the factory is exercised. The cases retain their original provider, routing and argument expectations. The fixture resets its pollers and process-local singletons, restores the original home lookup and cleans up its directory after the case. Five temporary directories add bounded filesystem work.

This change covers only the unit fixture whose command execution is mocked. Tests that execute subprocesses continue to use ordinary host admission. Production limits, account settings and admission logic are untouched. A revert restores the prior fixture setup without requiring data migration or a service restart.

## Focused verification

The authorized unit invocation ran once under enforcing admission. All five cases passed, with zero failures, pending cases or todos. The child exited 0 in 9.26 seconds including setup, and its exit was captured before reading the JSON report. The verification coordinator retains complete verification.
