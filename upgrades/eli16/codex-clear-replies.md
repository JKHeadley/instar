# Clearer replies from Codex agents

When a Codex agent gives an update, the user should be able to tell what it means and what happens next. Recent replies described internal design details but left the operator unsure whether the agent was making a change or asking for a decision.

Instar already generates an `AGENTS.md` instruction file for Codex agents. This change adds a short communication rule to that generated file. It tells Codex to use everyday words, start with the answer, explain what it found, state what it is doing next, and say plainly whether it needs anything from the user. It also tells the agent to translate internal labels and test outcomes into their practical meaning.

The rule is inserted when a new Codex instruction file is made. When an existing generated Codex file is found at session start without the new section, Instar refreshes it from the canonical identity file. Hand-authored files are left alone. Agents that do not use Codex do not receive the Codex section.

This changes guidance given to the model; it does not add a message filter or block a reply. The test checks both new and existing generated Codex files and verifies that a non-Codex agent is unaffected. If the wording does not help, the change can be reverted and the generated file refreshed on the next session start.
