# Mesh Resolver Startup Fallback — Plain-English Overview

## The problem

The multi-machine mesh is optional and initializes on a best-effort path. If an
earlier mesh setup step failed, a later session-pool callback still assumed the
mesh URL resolver existed. Restarting a configured agent could therefore crash
the whole server even though its older single-URL peer route was still usable.

## What changes

Peer URL lookup now goes through one small funnel. When the mesh resolver exists,
the funnel uses its preferred multi-rope endpoint. When it does not, the funnel
uses the peer's legacy registry URL, or reports no route if neither source exists.
Optional mesh degradation can no longer become a server-start prerequisite.

Unit, integration, and production-wiring lifecycle tests cover all three paths.

