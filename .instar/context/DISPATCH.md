# Context Dispatch Table

> When certain work arises, deeper context helps you be fully present.
> This table guides which context to surface.

| When you're about to... | Read this context | Why |
|------------------------|-------------------|-----|
| writing-code | `.instar/context/development.md` | Code conventions, testing patterns, architectural decisions for this project. |
| modifying-files | `.instar/context/development.md` | Code conventions, testing patterns, architectural decisions for this project. |
| debugging | `.instar/context/development.md` | Code conventions, testing patterns, architectural decisions for this project. |
| deploying | `.instar/context/deployment.md` | Deployment targets, CI/CD setup, environment variables, rollback procedures. |
| building | `.instar/context/deployment.md` | Deployment targets, CI/CD setup, environment variables, rollback procedures. |
| pushing-to-git | `.instar/context/deployment.md` | Deployment targets, CI/CD setup, environment variables, rollback procedures. |
| messaging-user | `.instar/context/communication.md` | User preferences, tone guidelines, when to proactively reach out. |
| sending-email | `.instar/context/communication.md` | User preferences, tone guidelines, when to proactively reach out. |
| writing-report | `.instar/context/communication.md` | User preferences, tone guidelines, when to proactively reach out. |
| answering-architecture-questions | `.instar/context/architecture.md` | System architecture, feature inventory, multi-user/multi-machine distinctions. ALWAYS consult /capabilities first. |
| explaining-features | `.instar/context/architecture.md` | System architecture, feature inventory, multi-user/multi-machine distinctions. ALWAYS consult /capabilities first. |
| multi-user-setup | `.instar/context/architecture.md` | System architecture, feature inventory, multi-user/multi-machine distinctions. ALWAYS consult /capabilities first. |
| multi-machine-setup | `.instar/context/architecture.md` | System architecture, feature inventory, multi-user/multi-machine distinctions. ALWAYS consult /capabilities first. |
| researching | `.instar/context/research-navigation.md` | Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch. |
| searching-broadly | `.instar/context/research-navigation.md` | Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch. |
| spawning-agents | `.instar/context/research-navigation.md` | Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch. |
| web-fetching | `.instar/context/research-navigation.md` | Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch. |
| checking-state | `.instar/context/research-navigation.md` | Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch. |
| interpreting-user-intent | `.instar/context/conversational-actions.md` | When the user expresses an intent in conversation (e.g., "let's switch to local"), look up the live catalog of invocable actions via the conversational-catalog SelfKnowledgeTree probe. Catalog is dynamic; this segment is the dispatch instruction, not the catalog itself. Per Instar Design Principle P1 (Structure>Willpower) and the AGENT.md bloat lesson (L1), the catalog is NEVER inlined into the always-loaded identity prompt — it loads on-demand only when an intent-interpretation moment matches. |
| matching-to-skill | `.instar/context/conversational-actions.md` | When the user expresses an intent in conversation (e.g., "let's switch to local"), look up the live catalog of invocable actions via the conversational-catalog SelfKnowledgeTree probe. Catalog is dynamic; this segment is the dispatch instruction, not the catalog itself. Per Instar Design Principle P1 (Structure>Willpower) and the AGENT.md bloat lesson (L1), the catalog is NEVER inlined into the always-loaded identity prompt — it loads on-demand only when an intent-interpretation moment matches. |
| translating-conversation-to-action | `.instar/context/conversational-actions.md` | When the user expresses an intent in conversation (e.g., "let's switch to local"), look up the live catalog of invocable actions via the conversational-catalog SelfKnowledgeTree probe. Catalog is dynamic; this segment is the dispatch instruction, not the catalog itself. Per Instar Design Principle P1 (Structure>Willpower) and the AGENT.md bloat lesson (L1), the catalog is NEVER inlined into the always-loaded identity prompt — it loads on-demand only when an intent-interpretation moment matches. |

## Always-Loaded Context (Tier 0)

These are injected automatically at every session start:
- `.instar/context/identity.md` — Agent name, role, principles, project scope. Always loaded.
- `.instar/context/safety.md` — Constraints, blocked commands, destructive action rules.
- `.instar/context/project.md` — Auto-generated project structure, key files, deployment targets.

## Session-Boundary Context (Tier 1)

These are loaded at session start, compaction, and resume:
- `.instar/context/session.md` — Session lifecycle, ownership, recovery procedures.
- `.instar/context/relationships.md` — Known people, interaction patterns, relationship maintenance.

*Auto-generated by Instar Context Hierarchy.*