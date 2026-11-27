# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The held Telegram reply tests advance the durable retry scheduler to the actual retry time through its existing clock inputs. They check that delivery waits until the operation is due and happens only once. The connection retry test uses loopback for both addresses and checks the difference between a refused connection and an unsupported network error.

## Evidence

Hosted main recorded the held reply tests timing out and the Node 20 connection test misclassifying an aggregate socket error. These changes cover those test fixtures.
