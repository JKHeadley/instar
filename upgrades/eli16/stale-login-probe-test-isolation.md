# Keep Login Recovery Tests Separate From Real Work

A login-recovery test sometimes said that a healthy account had to be replaced. That result can happen when the test accidentally competes with real work for the computer's process allowance. The test stores its account and probe files in a temporary folder, but the shared process limiter used the normal home folder. A busy machine could therefore prevent the test's small stand-in login probe from starting. Without a successful probe, the existing recovery code conservatively chose the swap path.

This repair gives the integration and lifecycle tests their own temporary limiter file. It keeps the real limiter, probe runner and recovery code in use, and checks the actual limiter path. A separate test deliberately fills that temporary allowance and confirms the probe does not start or record a reservation. Successful logins still refresh in place, and genuine sign-out still follows the existing swap path.

No production account choice, token pacing, credential, quota limit or recovery rule changes. A controlled occupied limiter reproduced the reported failure; the original full-run log was not available for an independent trace. Focused tests pass. Throughput must still run complete verification before release. Reverting this test-only repair requires no data migration.
