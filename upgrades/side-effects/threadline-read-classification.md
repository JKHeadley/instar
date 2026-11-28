# Threadline read classification side-effects review

The common external-operation gate now recognizes six exact Threadline lookup names as reads. This fixes false approval holds for agent discovery, agent listing, history, and registry lookup. Threadline's handler-level authentication, result filtering, and thread participant checks continue to apply.

The classification uses an exact service and tool name. Send, acknowledgment, delete, registry update, and unknown names keep their existing handling. The repair adds no standing grant or migration and exposes no new endpoint. Reads use their existing Threadline transport and destinations.

The unit fixture covers the six reads and five guarded names. The production startup fixture checks discovery, listing, send, and delete via the HTTP gate before and after a restart. A revert restores the former classification and may bring back false holds on these reads.

Network discovery and registry search send their caller-supplied search filters to the existing relay or registry. Local discovery can refresh its known-agent cache, and reading history can trigger the existing one-time local backfill.

The Chief of Staff’s reviewer concurred on source and test patch SHA-256 459cd97721c60612d3d7f4eef8c3c9c5e75c493690143827baa024492fe4f90a.
