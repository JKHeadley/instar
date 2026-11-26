# Retaining verified peer custody for protected App history

An unmounted import helper checks that a peer custody record names the expected exact conversation, creation event and machine. The record must match both independently verified creation origin and authenticated envelope origin. Missing creation evidence waits. Conflicting evidence refuses. Only an exact match can retain or confirm the immutable local record. Extra payload fields, including a clearing instruction, are refused.

This helper consumes verified evidence supplied by a future transport. It does not authenticate a peer, register a replicated kind, establish inventory completeness or change reads, writes or production activation.

## 6b. Operator-surface quality

A peer can retain a valid protected-history assignment without granting a different machine custody.

## Framework generality

The import checks exact App and machine identity independently of device platform.

## Independent review

Concur for the unmounted store import. Pending provenance writes nothing, verified scope agrees before retention, and a conflicting record cannot replace the retained tuple.
