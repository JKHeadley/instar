# Give the GitHub Actions merge tests their own agent configuration

Six tests check whether the merge command waits for GitHub Actions and checks which workflow produced each result. They use a fake GitHub command. Previously the merge script still ran from the developer’s checkout, so it could find the real agent configuration and switch to local verification.

Each test now runs the real script from a temporary installed-agent directory with its own configuration. The test selects Actions mode and checks that the script resolves the temporary directory and reads a configuration without a verification server address or credential source. The test removes its directory afterward. A separate suite exercises the local verification rules against a temporary server.
