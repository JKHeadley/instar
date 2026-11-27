# Codex Hooks During Project Setup

When you set up an Instar project and select Codex, setup should write the project hooks that Codex uses for tasks such as recovering conversation context. The option already saves your choice. Two setup paths left the hook file absent until an update or hook refresh.

Both paths will now write the same project hook configuration. This applies when you create a named project and when you initialize an existing directory. It applies to Codex-only projects and projects that use both Codex and Claude Code. Existing custom Codex hooks are kept alongside the Instar hooks, and the existing Codex trust process still determines whether those hooks can run.

The change happens during setup. Existing projects receive the hook files through the update path already in use. The default Claude-only setup continues to install the Claude Code settings.
