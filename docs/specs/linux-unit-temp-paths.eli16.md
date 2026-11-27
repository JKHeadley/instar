# Linux unit test environment fixes — plain-English overview

> The test suite should give the same answer on macOS and Linux, whether or not someone has set `TMPDIR`.

## The problem

Four unit test files produced different results across machines. Some tests created a supposed throwaway agent in whatever directory Node called temporary. On this Linux machine, `TMPDIR` points under the user's home, and Instar correctly does not regard that as a fixed operating-system temporary location. Those tests were therefore asking a normal-location agent to behave like a throwaway. A media copy test also assumed an asynchronous copy would finish within five short polling attempts.

There is one product defect as well. Agent-owned memory used the configured temporary directory as evidence that an agent was throwaway. If `TMPDIR` was a normal home directory, it could refuse to connect that agent's memory to its login. This change uses Instar's existing fixed-temp-root rule for that decision.

## What changes

The throwaway tests now create their agents in `/tmp`, the fixed OS temp root supported on both macOS and Linux. The memory fixture declares its own project root so a surrounding checkout does not change the test. The media test waits for the copy completion result instead of racing an arbitrary 125 ms window. Agent-owned memory uses the same temp-root classification as the throwaway guard. A source-tree test pins its own git root instead of inheriting an ambient `/tmp/.git`, an idle-backoff test records actual sleep calls instead of treating host scheduling delay as a deliberate sleep, and a config-reader test counts source byte reads instead of metadata polls. Its deliberately blocked read still times out; its later healthy worker read has enough time on a busy host. No test is skipped, deleted, or limited by platform.

## Safeguards and decision

A user-configured `TMPDIR` is not a reliable statement about whether an agent is temporary. The existing guard deliberately ignores it because a service may restart without inheriting that setting. Reusing that rule keeps memory linking consistent with the rest of Instar. The change does not touch existing memory contents or live agent state. A revert restores the previous behavior if a regression appears. Reviewers should decide whether these test fixtures and the shared temp-root rule match the intended Mac and Linux behavior.
