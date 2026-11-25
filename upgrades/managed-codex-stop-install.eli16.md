# Deliver the dark Stop hook to existing installations

Instar updates an existing built-in hook when it can verify that the installed file is the exact prior packaged version. The update adds transport for the managed Codex continuation test. The switch stays off, and current launches keep using their existing behavior.

If an operator edited the hook, Instar preserves the edit. The updater now warns when that hook still calls the known old authentication helper and the helper is missing. This is the specific condition that caused a Studio hook to stop without continuing. The warning names the missing file and points the operator to the packaged hook for comparison. It does not automatically replace the edited file, change credentials, or enable the feature.

On the next update, someone using an unedited packaged hook gets the new transport automatically. If Instar warns about a local edit, compare the two copies before deciding whether to update it.
