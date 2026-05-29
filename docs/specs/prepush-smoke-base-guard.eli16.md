# ELI16: Pre-push Smoke Base Resolver and Breadth Guard

The pre-push hook is meant to be a quick local check before a branch is pushed. It should catch obvious test failures quickly, then let the pull request CI run the full authoritative test suite.

The bug was that the local smoke check could compare the branch against the wrong remote base. If the base was stale or unrelated, the tool believed many files had changed and selected a very large set of tests. That made a "quick smoke check" run for a long time, even though CI would still be the real gate later.

This change teaches the hook how to choose a better base. It first looks at the branch's configured upstream or push remote, because that is usually the remote the developer or agent is actually pushing to. If that is not available, it tries the standard main branches in a predictable order: `JKHeadley/main`, then `upstream/main`, then `origin/main`.

The hook also prints what it chose before running tests: the base reference and how many files changed relative to that base. If the changed file count or selected test count is too large, the hook stops the local smoke run and says plainly that local smoke is too broad and CI is the authority. This keeps local feedback fast without weakening the real merge checks.
