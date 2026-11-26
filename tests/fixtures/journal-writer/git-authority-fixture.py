"""Dark Git authority baseline. Only touches disposable local Git repositories."""

import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid
import tempfile
import time
import unittest

REF = "refs/heads/journal-authority"
ZERO = "0" * 40


def git(directory, *args, data=None, extra_env=None, check=True):
    # Pin identity and exclude the caller's Git config and repository variables.
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "HOME") if key in os.environ}
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    })
    env.update(extra_env or {})
    return subprocess.run(["git", *args], cwd=directory, input=data, capture_output=True, env=env, check=check)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_state(repository, oid):
    return json.loads(git(repository, "show", f"{oid}:authority.json").stdout)


def authorization_bytes(audience, actor, old_oid, new_oid, ref):
    return json.dumps({
        "audience": audience, "principal": actor, "previous": old_oid,
        "candidate": new_oid, "ref": ref,
    }, sort_keys=True, separators=(",", ":")).encode()


def authenticate(repository, old_oid, new_oid, ref):
    actor = os.environ.get("FIXTURE_PRINCIPAL")
    if actor not in {"publisher", "old", "next", "intruder"}:
        raise ValueError("missing receiver principal")
    signature = base64.b64decode(os.environ.get("FIXTURE_SIGNATURE", ""), validate=True)
    if not signature or len(signature) > 4096:
        raise ValueError("missing or invalid receiver signature")
    audience = (repository / "fixture-audience").read_text()
    with tempfile.NamedTemporaryFile() as signed:
        signed.write(signature)
        signed.flush()
        verified = subprocess.run([
            "ssh-keygen", "-Y", "verify", "-f", str(repository / "fixture-allowed-signers"),
            "-I", actor, "-n", "instar-journal-authority-fixture", "-s", signed.name,
        ], input=authorization_bytes(audience, actor, old_oid, new_oid, ref), capture_output=True)
    if verified.returncode:
        raise ValueError("receiver signature did not verify")
    return actor


def prepared_receiver(repository, lines):
    for line in lines:
        old_oid, new_oid, ref = line.split()
        if ref != REF or new_oid == ZERO:
            raise ValueError("unexpected ref or deletion")
        actor = authenticate(repository, old_oid, new_oid, ref)
        parents = git(repository, "rev-list", "--parents", "-n", "1", new_oid).stdout.decode().split()[1:]
        new = read_state(repository, new_oid)
        if old_oid == ZERO:
            if parents or actor != "publisher" or new != genesis():
                raise ValueError("invalid genesis")
            continue
        if parents != [old_oid]:
            raise ValueError("candidate does not directly follow the current tip")
        old = read_state(repository, old_oid)
        command = new["command"]
        for name, field in (("decision.json", "decision"), ("intent.json", "intent")):
            if new.get(field) is not None:
                content = git(repository, "show", f"{new_oid}:{name}").stdout
                if sha(content) != new[field]:
                    raise ValueError("invalid decision or intent bytes")
        now = int((repository / "fixture-clock").read_text())
        if command == "append":
            if old["phase"] != "active" or actor != old["writer"] or now >= old["expires"]:
                raise ValueError("writer inactive, unauthorized or expired")
            if old["intent"] is not None:
                raise ValueError("uncertain intent requires exact reconciliation")
            payload = git(repository, "show", f"{new_oid}:decision.json").stdout
            intent = git(repository, "show", f"{new_oid}:intent.json").stdout
            if json.loads(payload)["operation"] != json.loads(intent)["operation"]:
                raise ValueError("decision and intent operation differ")
            if new != {**old, "command": "append", "expectedIntent": old["intent"],
                       "decision": sha(payload), "intent": sha(intent)}:
                raise ValueError("invalid decision or intent transition")
        elif command == "fold":
            if old["phase"] != "active" or actor != old["writer"] or now >= old["expires"]:
                raise ValueError("fold inactive, unauthorized or expired")
            if old["intent"] is not None or new != {**old, "command": "fold"}:
                raise ValueError("fold lacks a reconciled current generation")
        elif command == "begin":
            if actor != "publisher" or old["phase"] != "active":
                raise ValueError("publisher cannot begin from current phase")
            if new != {**old, "command": "begin", "phase": "pending", "candidate": "next-cutover"}:
                raise ValueError("invalid pending transition")
        elif command == "activate":
            if actor != "publisher" or old["phase"] != "pending":
                raise ValueError("publisher cannot activate from current phase")
            if (repository / "fixture-witness").read_text() != old_oid:
                raise ValueError("witness does not confirm the exact pending tip")
            if new != {**old, "command": "activate", "phase": "active",
                       "generation": old["generation"] + 1, "writer": "next", "expires": 20}:
                raise ValueError("invalid activation")
        else:
            raise ValueError("unknown command")


def check_recovered_tip(repository, tip, witness_path):
    """Fixture recovery fence. An unavailable or disagreeing witness closes ingress."""
    try:
        witness = json.loads(witness_path.read_bytes())
        state = read_state(repository, tip)
        return state["phase"] == "active" and witness == {
            "generation": state["generation"], "tip": tip,
        }
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        return False


def publish_floor(path, generation, tip):
    staged = path.with_suffix(".tmp")
    with staged.open("xb") as output:
        output.write(json.dumps({"generation": generation, "tip": tip}).encode())
        output.flush()
        os.fsync(output.fileno())
    staged.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def witness_connection(path, mode):
    return sqlite3.connect(f"{path.as_uri()}?mode={mode}", uri=True)


def start_witness(path, tip):
    with witness_connection(path, "rwc") as db:
        db.executescript("""
            CREATE TABLE floor(generation INTEGER, phase TEXT, expires INTEGER, tip TEXT, time INTEGER);
            CREATE TABLE receipts(tip TEXT PRIMARY KEY, generation INTEGER, decision TEXT, intent TEXT, accepted_at INTEGER);
        """)
        db.execute("INSERT INTO floor VALUES (1, 'active', 10, ?, 1)", (tip,))


def witness_acknowledge(path, previous, tip, state):
    # The clock is synthetic. The fixture models the witness accepting the
    # exact Git object independently of the receiver's earlier clock check.
    with witness_connection(path, "rw") as db:
        db.execute("BEGIN IMMEDIATE")
        generation, phase, expires, current, now = db.execute(
            "SELECT generation, phase, expires, tip, time FROM floor"
        ).fetchone()
        if phase != "active" or generation != state["generation"] or now >= expires or current != previous:
            return False
        db.execute("INSERT INTO receipts VALUES (?, ?, ?, ?, ?)",
                   (tip, generation, state["decision"], state["intent"], now))
        db.execute("UPDATE floor SET tip=?", (tip,))
        return True


def witness_allows_fold(path, tip, state):
    try:
        with witness_connection(path, "ro") as db:
            match = db.execute("""
                SELECT 1 FROM floor JOIN receipts USING (tip, generation)
                WHERE floor.phase='active' AND tip=? AND generation=?
                  AND decision=? AND intent=? AND accepted_at<expires
            """, (tip, state["generation"], state["decision"], state["intent"])).fetchone()
            return match is not None
    except (OSError, sqlite3.Error):
        return False


def genesis():
    return {"command": "genesis", "phase": "active", "generation": 1,
            "writer": "old", "expires": 10, "intent": None}


class GitAuthorityFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="journal-git-authority-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.root = root
        self.remote = root / "authority.git"
        self.local = root / "client"
        self.remote.mkdir()
        self.local.mkdir()
        git(self.remote, "init", "--bare", "--object-format=sha1")
        git(self.local, "init", "--object-format=sha1")
        git(self.remote, "config", "receive.denyNonFastForwards", "true")
        self.audience = uuid.uuid4().hex
        (self.remote / "fixture-audience").write_text(self.audience)
        keys_dir = root / "fixture-keys"
        keys_dir.mkdir()
        self.keys = {}
        allowed_signers = []
        for actor in ("publisher", "old", "next", "intruder"):
            key = keys_dir / actor
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-f", str(key), "-N", ""],
                           check=True, capture_output=True)
            self.keys[actor] = key
            allowed_signers.append(f"{actor} {key.with_suffix('.pub').read_text()}")
        (self.remote / "fixture-allowed-signers").write_text("".join(allowed_signers))
        self.clock(1)
        (self.remote / "fixture-witness").write_text("")
        hook = self.remote / "hooks/reference-transaction"
        import shlex
        script = shlex.quote(str(Path(__file__).resolve()))
        python = shlex.quote(sys.executable)
        hook.write_text(f'#!/bin/sh\n[ "$1" = prepared ] || exit 0\nexec {python} {script} --receiver\n')
        hook.chmod(0o700)
        self.initial = self.candidate(genesis())
        self.assertEqual(self.push(self.initial, "publisher").returncode, 0)

    def clock(self, clock):
        (self.remote / "fixture-clock").write_text(str(clock))

    def candidate(self, state, parent=None, writes=None):
        (self.local / "authority.json").write_text(json.dumps(state, sort_keys=True))
        for filename, content in (writes or {}).items():
            (self.local / filename).write_bytes(content)
        git(self.local, "add", ".")
        tree = git(self.local, "write-tree").stdout.decode().strip()
        parents = ["-p", parent] if parent else []
        return git(self.local, "commit-tree", tree, *parents, "-m", state["command"]).stdout.decode().strip()

    def token(self, oid, actor, signer=None, audience=None):
        parents = git(self.local, "rev-list", "--parents", "-n", "1", oid).stdout.decode().split()[1:]
        previous = parents[0] if parents else ZERO
        signed = subprocess.run([
            "ssh-keygen", "-Y", "sign", "-f", str(self.keys[signer or actor]),
            "-n", "instar-journal-authority-fixture",
        ], input=authorization_bytes(audience or self.audience, actor, previous, oid, REF),
           check=True, capture_output=True)
        return base64.b64encode(signed.stdout).decode()

    def push(self, oid, actor, signature=None):
        if signature is None:
            signature = self.token(oid, actor)
        return git(self.local, "push", str(self.remote), f"{oid}:{REF}",
                   extra_env={"FIXTURE_PRINCIPAL": actor, "FIXTURE_SIGNATURE": signature}, check=False)

    def tip(self):
        return git(self.local, "ls-remote", "--refs", str(self.remote), REF).stdout.decode().split()[0]

    def append_candidate(self, parent, **overrides):
        previous = read_state(self.local, parent)
        payload = b'{"operation":"decide"}\n'
        intent = b'{"operation":"decide","position":1}\n'
        next_state = {**previous, "command": "append", "expectedIntent": previous["intent"],
                      "decision": sha(payload), "intent": sha(intent), **overrides}
        return self.candidate(next_state, parent, {"decision.json": payload, "intent.json": intent})

    def begin(self, base):
        state = read_state(self.local, base)
        pending = self.candidate({**state, "command": "begin", "phase": "pending",
                                  "candidate": "next-cutover"}, base)
        self.assertEqual(self.push(pending, "publisher").returncode, 0)
        return pending

    def test_receiver_binds_signature_to_principal_audience_and_exact_candidate(self):
        candidate = self.append_candidate(self.initial)
        altered = self.append_candidate(self.initial, generation=2)
        for attempted, signature in (
            (candidate, ""),
            (candidate, self.token(candidate, "old", signer="intruder")),
            (candidate, self.token(candidate, "old", audience="different-receiver")),
            (altered, self.token(candidate, "old")),
        ):
            self.assertIn(b"signature", self.push(attempted, "old", signature).stderr)
            self.assertEqual(self.tip(), self.initial)
        self.assertEqual(self.push(candidate, "old").returncode, 0)
        self.assertEqual(self.tip(), candidate)

    def test_expired_writer_refused_on_unchanged_tip(self):
        candidate = self.append_candidate(self.initial)
        self.clock(10)
        refused = self.push(candidate, "old")
        self.assertIn(b"expired", refused.stderr)
        self.assertEqual(self.tip(), self.initial)

    def test_receiver_rejects_unauthorized_and_invalid_fast_forwards(self):
        valid = self.append_candidate(self.initial)
        self.assertIn(b"unauthorized", self.push(valid, "intruder").stderr)
        for invalid in ({"generation": 2}, {"expectedIntent": "wrong"}, {"intent": "wrong"}):
            candidate = self.append_candidate(self.initial, **invalid)
            self.assertIn(b"invalid decision", self.push(candidate, "old").stderr)
            self.assertEqual(self.tip(), self.initial)

    def test_paused_writer_and_both_generations_blocked_while_pending(self):
        prepared = self.append_candidate(self.initial)
        pending = self.begin(self.initial)
        self.assertNotEqual(self.push(prepared, "old").returncode, 0)
        state = read_state(self.local, pending)
        fold = self.candidate({**state, "command": "fold"}, pending)
        for actor in ("old", "next"):
            self.assertIn(b"inactive", self.push(self.append_candidate(pending), actor).stderr)
            self.assertIn(b"fold inactive", self.push(fold, actor).stderr)
        activation = self.candidate({**state, "command": "activate", "phase": "active",
                                     "generation": 2, "writer": "next", "expires": 20}, pending)
        self.assertIn(b"witness", self.push(activation, "publisher").stderr)
        self.assertEqual(self.tip(), pending)
        (self.remote / "fixture-witness").write_text(pending)
        self.assertEqual(self.push(activation, "publisher").returncode, 0)
        self.assertIn(b"unauthorized", self.push(self.append_candidate(activation), "old").stderr)
        self.assertEqual(self.tip(), activation)

    def test_receiver_stall_after_expiry_check_exposes_commit_gap(self):
        candidate = self.append_candidate(self.initial)
        witness = self.root / "acceptance.sqlite"
        start_witness(witness, self.initial)
        # The sidecar barrier holds the prepared hook after validation. Git
        # cannot check wall time and update the ref as one indivisible action.
        barrier = self.remote / "fixture-after-check"
        barrier.mkdir()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            push = executor.submit(self.push, candidate, "old")
            try:
                deadline = time.monotonic() + 10
                while not (barrier / "validated").exists():
                    if push.done() or time.monotonic() >= deadline:
                        self.fail("receiver did not reach the post-validation barrier")
                    time.sleep(0.01)
                self.clock(10)
                with witness_connection(witness, "rw") as db:
                    db.execute("UPDATE floor SET time=10")
            finally:
                (barrier / "resume").touch()
            result = push.result(timeout=10)

        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(self.tip(), candidate)
        state = read_state(self.remote, candidate)
        self.assertFalse(witness_acknowledge(witness, self.initial, candidate, state))
        self.assertFalse(witness_allows_fold(witness, candidate, state))
        with witness_connection(witness, "rw") as db:
            db.execute("UPDATE floor SET generation=2, phase='pending'")
        self.assertFalse(witness_acknowledge(witness, self.initial, candidate, state))
        self.assertFalse(witness_allows_fold(witness, candidate, state))

    def test_restored_backup_and_missing_witness_keep_ingress_closed(self):
        backup = self.root / "backup.git"
        git(self.root, "clone", "--bare", str(self.remote), str(backup))
        witness = self.root / "witness" / "floor.json"
        witness.parent.mkdir()
        publish_floor(witness, 1, self.initial)
        self.assertTrue(check_recovered_tip(backup, self.initial, witness))

        pending = self.begin(self.initial)
        state = read_state(self.local, pending)
        self.assertFalse(check_recovered_tip(self.remote, pending, witness))
        activation = self.candidate({**state, "command": "activate", "phase": "active",
                                     "generation": 2, "writer": "next", "expires": 20}, pending)
        (self.remote / "fixture-witness").write_text(pending)
        self.assertEqual(self.push(activation, "publisher").returncode, 0)
        self.assertFalse(check_recovered_tip(self.remote, activation, witness))
        publish_floor(witness, 2, activation)

        self.assertTrue(check_recovered_tip(self.remote, activation, witness))
        self.assertFalse(check_recovered_tip(backup, self.initial, witness))
        self.assertFalse(check_recovered_tip(self.remote, activation, witness.with_name("unavailable.json")))

    def test_witness_receipt_recovers_exact_acceptance_and_refuses_stale_or_unavailable_state(self):
        witness = self.root / "acceptance.sqlite"
        start_witness(witness, self.initial)
        candidate = self.append_candidate(self.initial)
        self.assertEqual(self.push(candidate, "old").returncode, 0)
        state = read_state(self.remote, candidate)
        self.assertFalse(witness_allows_fold(witness, candidate, state))
        witness_acknowledge(witness, self.initial, candidate, state)  # Lose response.
        with witness_connection(witness, "rw") as db:
            db.execute("UPDATE floor SET time=10")
        self.assertTrue(witness_allows_fold(witness, candidate, state))
        self.assertFalse(witness_allows_fold(witness, self.initial, state))
        self.assertFalse(witness_allows_fold(witness, candidate, {**state, "intent": "different"}))
        self.assertFalse(witness_allows_fold(witness.with_name("missing.sqlite"), candidate, state))
        with witness_connection(witness, "rw") as db:
            db.execute("UPDATE floor SET phase='pending'")
        self.assertFalse(witness_allows_fold(witness, candidate, state))

    def test_recover_push_ack_from_exact_remote_tip_and_bytes(self):
        candidate = self.append_candidate(self.initial)
        self.push(candidate, "old")  # Discard the client outcome.
        self.assertEqual(self.tip(), candidate)
        state = read_state(self.remote, candidate)
        for name, field in (("decision.json", "decision"), ("intent.json", "intent")):
            self.assertEqual(sha(git(self.remote, "show", f"{candidate}:{name}").stdout), state[field])
        second_append = self.append_candidate(candidate)
        self.assertIn(b"requires exact reconciliation", self.push(second_append, "old").stderr)
        pending = self.begin(candidate)
        self.assertEqual(read_state(self.remote, pending)["intent"], state["intent"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--receiver"]:
        try:
            repository = Path.cwd()
            prepared_receiver(repository, sys.stdin)
            barrier = repository / "fixture-after-check"
            if barrier.is_dir():
                (barrier / "validated").touch()
                deadline = time.monotonic() + 15
                while not (barrier / "resume").exists():
                    if time.monotonic() >= deadline:
                        raise ValueError("fixture barrier timed out")
                    time.sleep(0.01)
        except (KeyError, ValueError, subprocess.CalledProcessError) as error:
            sys.exit(str(error))
    else:
        unittest.main(verbosity=2)
