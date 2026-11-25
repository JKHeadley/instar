# Use the current authority for managed continuation

The server can now ask the currently published ownership provider which computer holds a project conversation. The answer is available only for the verified single-machine setup and only while the ownership provider is ready. If the server replaces or closes that provider, the old one stops answering immediately.

The saved ownership record alone cannot supply permission. The provider also checks the current computer, server lock and serving lease. The tests cover a new provider taking over, the real single-machine ownership factory, and both packaged continuation cases. This change prepares the ownership input for the managed launch path. It does not start a production worker or turn continuation on. The launch path still needs to tie the ownership version to the exact new worker before authorizing turns.
