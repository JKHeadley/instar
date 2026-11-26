"""Dark model of observing durable state before sampling a bounded clock."""

import hashlib
import hmac
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile
import unittest


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class DeadlineFixture:
    def __init__(self, path):
        self.path = path
        self.observer_key = secrets.token_bytes(32)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE authority(generation INTEGER, live INTEGER);
                INSERT INTO authority VALUES (1, 1);
                CREATE TABLE stages(id TEXT PRIMARY KEY, bytes BLOB, generation INTEGER, deadline INTEGER);
                CREATE TABLE proofs(id TEXT PRIMARY KEY, evidence BLOB, signature BLOB);
                CREATE TABLE folds(id TEXT PRIMARY KEY, generation INTEGER);
            """)

    def connection(self):
        db = sqlite3.connect(self.path)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def signature(self, evidence):
        return hmac.digest(self.observer_key, b"fixture-durable-deadline-v1\0" + evidence, "sha256")

    def observe(self, stage_id, sample_upper_bound, *, crash_before_proof=False):
        # A separate connection cannot read the staging writer's uncommitted
        # rows. This fixture models a trusted path with durable visibility.
        with self.connection() as db:
            row = db.execute("SELECT bytes,generation,deadline FROM stages WHERE id=?", (stage_id,)).fetchone()
        if row is None:
            return False
        payload, generation, deadline = row
        upper = sample_upper_bound()
        if upper is None or upper >= deadline or crash_before_proof:
            return False
        evidence = canonical({
            "namespace": "fixture-journal", "stage": stage_id, "generation": generation,
            "sha256": hashlib.sha256(payload).hexdigest(), "deadline": deadline,
            "observedUpperBound": upper, "ordering": "durable-read-before-clock",
        })
        with self.connection() as db:
            db.execute("INSERT INTO proofs VALUES (?,?,?)", (stage_id, evidence, self.signature(evidence)))
        return True

    def publish_fold(self, stage_id):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""
                SELECT evidence, signature, bytes, stages.generation, deadline
                FROM stages JOIN proofs USING (id) JOIN authority
                  ON stages.generation=authority.generation AND authority.live=1
                WHERE id=?
            """, (stage_id,)).fetchone()
            if row is None:
                return False
            evidence, signature, payload, generation, deadline = row
            signed = json.loads(evidence)
            if not hmac.compare_digest(signature, self.signature(evidence)):
                return False
            upper = signed.get("observedUpperBound")
            if type(upper) is not int or upper >= deadline or signed != {
                "namespace": "fixture-journal", "stage": stage_id, "generation": generation,
                "sha256": hashlib.sha256(payload).hexdigest(), "deadline": deadline,
                "observedUpperBound": upper, "ordering": "durable-read-before-clock",
            }:
                return False
            db.execute("INSERT INTO folds VALUES (?,?)", (stage_id, generation))
            return True


class DurableDeadlineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="journal-deadline-")
        self.addCleanup(temporary.cleanup)
        self.fixture = DeadlineFixture(Path(temporary.name) / "witness.sqlite")

    def stage(self, db):
        db.execute("INSERT INTO stages VALUES ('exact', ?, 1, 10)", (b"decision-and-intent",))

    def test_provisional_visibility_cannot_produce_evidence(self):
        with self.fixture.connection() as writer:
            self.stage(writer)
            self.assertFalse(self.fixture.observe("exact", lambda: self.fail("clock sampled before durable read")))
        self.assertTrue(self.fixture.observe("exact", lambda: 9))
        self.assertTrue(self.fixture.publish_fold("exact"))

    def test_uncertain_or_late_clock_bound_stays_pending(self):
        with self.fixture.connection() as writer:
            self.stage(writer)
        for upper in (None, 10, 11):
            self.assertFalse(self.fixture.observe("exact", lambda: upper))
        self.assertFalse(self.fixture.publish_fold("exact"))

    def test_crash_before_recoverable_proof_cannot_backdate(self):
        with self.fixture.connection() as writer:
            self.stage(writer)
        self.assertFalse(self.fixture.observe("exact", lambda: 9, crash_before_proof=True))
        self.assertFalse(self.fixture.observe("exact", lambda: 10))
        self.assertFalse(self.fixture.publish_fold("exact"))

    def test_generation_change_blocks_publication_despite_historical_proof(self):
        with self.fixture.connection() as writer:
            self.stage(writer)
        self.assertTrue(self.fixture.observe("exact", lambda: 9))
        with self.fixture.connection() as authority:
            authority.execute("UPDATE authority SET generation=2")
        self.assertFalse(self.fixture.publish_fold("exact"))

    def test_delayed_generation_advance_cannot_prove_deadline(self):
        # A postcommit generation reread can still report 1 after time 10.
        with self.fixture.connection() as writer:
            self.stage(writer)
        with self.fixture.connection() as reader:
            self.assertEqual(reader.execute("SELECT generation FROM authority").fetchone(), (1,))
        self.assertFalse(self.fixture.observe("exact", lambda: 10))
        self.assertFalse(self.fixture.publish_fold("exact"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
