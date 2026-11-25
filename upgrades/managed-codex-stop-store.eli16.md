# Prepare durable records for Codex project work

Before Instar can automatically continue a project, it needs to remember who owns the work and whether it has already issued an instruction. This change adds an internal store for those records. It uses one local database transaction for each decision, so two requests cannot both reserve the same work or both issue a response for the same callback. It remembers the original instruction if Instar closes and reopens the database.

The tests cover a pending launch, a disabled setting, a duplicate request, and a pause while an instruction is outstanding. An ordinary session has no managed record and keeps its existing behavior. This change does not connect the store to the server or enable continuation. The later integration must supply the verified project admission and call the store through the authenticated Stop path.
