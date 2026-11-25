# A link when npm temporarily pauses publishing

On November 8, npm rejected Instar releases because the publishing account was temporarily suspended. A separate GitHub workflow can still build a development release during a publishing pause. That option already exists, but a maintainer reading the failed publish log has no direct route to the instructions.

This change gives release maintainers a link when npm returns both the error code and the verified account suspension message for Instar. The hint starts disabled. When enabled, it prints one message and preserves the result from npm so the publish workflow still stops on failure. Other permission problems and a successful publish take their usual paths.

The development build is an opt-in GitHub prerelease for development agents. The maintainer decides whether to use it while waiting for npm to lift the suspension. Clearing the repository setting switches the hint off.
