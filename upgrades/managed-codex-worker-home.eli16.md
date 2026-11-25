# Give each continuation worker its own Codex home

A new managed worker now gets a private Codex home for that launch. The directory cannot overlap its project workspace. The server stores the identity of that directory with the worker’s native session ID. If the directory is linked elsewhere, replaced, missing, or accessible to other users, the server refuses to use it for continuation.

The packaged lifecycle tests use this private home. Unit tests separately check a nested workspace, a reused launch name, bad permissions, links, and a replacement directory at the same path. This change prepares a launch requirement and does not enable production continuation. The production launcher still needs to create the home under its trusted state directory and give the worker only the credentials it needs.
