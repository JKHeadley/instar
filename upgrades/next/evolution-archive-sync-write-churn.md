# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Evolution archive sync between machines no longer rewrites the whole archive on every peer-presence event. After a complete scan of a peer, its next full rescan waits 15 minutes instead of starting at the next presence event, and an imported page that adds nothing new writes nothing. Retry charging before a request, cursor advance only after a durable import, and the failure park are unchanged. On the M5 the old behavior rewrote an 856 KiB archive about once a second, and the same churn was measured on the Mini, Laptop and Studio. A rescan still writes its retry and cursor bookkeeping twice per page.

## What to Tell Your User

I was quietly wearing out a machine's disk space. When my machines kept each other's archives in sync, one kept rewriting a large file about once a second, even when nothing had changed. Now it rescans each machine every fifteen minutes instead of every few seconds, and it skips rewriting the archive when a page brings nothing new. That's a small fraction of the old writing, and nothing is lost in the process.

## Summary of New Capabilities

Far fewer disk writes from archive sync between machines (no visible change).

## Evidence

tests/unit/evolution-archive.test.ts: an import adding nothing writes nothing; 45 presence events after a complete scan cause no fetch and no write, and the rescan after 15 minutes writes exactly twice; a peer that gained memory is picked up at the next rescan. evolution-archive plus self-action-convergence 950/950; graph-source-paged-history-held 4/4; tsc clean.
