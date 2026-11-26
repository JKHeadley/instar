"""Dark Git authority baseline. Only touches disposable local Git repositories."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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


def prepared_receiver(repository, lines):
    # The principal is supplied by this fixture's local transport driver.
    # A real receiver must obtain it from authenticated server context.
    actor = os.environ.get("FIXTURE_PRINCIPAL")
    for line in lines:
        old_oid, new_oid, ref = line.split()
        if ref != REF or new_oid == ZERO:
            raise ValueError("unexpected ref or deletion")
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


def genesis():
    return {"command": "genesis", "phase": "active", "generation": 1,
            "writer": "old", "expires": 10, "intent": None}


class GitAuthorityFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="journal-git-authority-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.remote = root / "authority.git"
        self.local = root / "client"
        self.remote.mkdir()
        self.local.mkdir()
        git(self.remote, "init", "--bare", "--object-format=sha1")
        git(self.local, "init", "--object-format=sha1")
        git(self.remote, "config", "receive.denyNonFastForwards", "true")
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

    def push(self, oid, actor):
        return git(self.local, "push", str(self.remote), f"{oid}:{REF}",
                   extra_env={"FIXTURE_PRINCIPAL": actor}, check=False)

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
            prepared_receiver(Path.cwd(), sys.stdin)
        except (KeyError, ValueError, subprocess.CalledProcessError) as error:
            sys.exit(str(error))
    else:
        unittest.main(verbosity=2)
