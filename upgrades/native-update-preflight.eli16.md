# Native update preflight — plain language

> An agent keeps running on its current version when a downloaded update cannot start with its native database module.

## The problem

Instar downloads updates into each agent's private installation. It was changing that installation in place. If the native SQLite module failed to rebuild, the updater logged a warning but still treated the update as successful. The agent could then restart into an installation that could not serve requests. Inspec on the laptop exposed this failure.

## What already exists

The updater checks for a new version and downloads it. A supervisor restarts the agent from its private installation after the updater asks for a restart. The updater also retries failed installs and records its last error. Those pieces remain in use.

## What changes

The download and native rebuild now happen in a separate candidate directory. Before changing the active installation, Instar starts the candidate CLI with the same Node executable the supervisor will use and confirms the candidate reports the expected version. It then loads the candidate's SQLite package, opens a temporary database, and runs a query. Only a candidate that passes all checks replaces the active installation.

If any step fails, the updater removes the candidate, records why it failed, and leaves the existing installation available. The update stays pending so the normal update cycle can retry it. This change does not require an agent owner to repair a native module by hand.

The same preparation and checks apply when rolling back to an older version. During the final switch, the previous installation is kept as a backup. If power loss or process interruption happens between the two directory moves, the agent's startup wrapper restores that backup before starting. Existing agents get the refreshed wrapper through the normal update migration.

## Decision

Ship this narrow, reversible change to the updater so native build failures cannot trigger a restart into the broken candidate.
