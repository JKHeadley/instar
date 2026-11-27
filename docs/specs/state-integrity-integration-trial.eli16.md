# Measuring startup tokens for state integrity

The state integrity review checks for orphaned jobs, stale references, oversized files and configuration mismatches. Four saved runs used Bash and the local Skill tool with no direct project integration calls. Median startup input was 81,013 tokens including cached input.

The trial starts disabled. Baseline mode measures the ordinary launch. Treatment measures a supported Claude launch with an empty project integration list. Both use the same review, local tools and schedule. Missing prerequisites keep the normal launch. An explicit integration policy still takes precedence. The trial changes no rule about when a repair can be performed.

Authenticated job history shows which variant ran and its first measured token event. Missing usage remains unknown. A local replay supplies a finished job that still has an active entry. Both variants report the orphan while the fixture remains untouched. A running job produces no report in the same replay. The fixture checks the launch and reporting paths. Actual savings and real recovery-path behavior still require observation after verification.
