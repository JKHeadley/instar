"""Exercise the original CLI of an installed release against disposable state."""
from contextlib import nullcontext
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

package = Path(sys.argv[1]).resolve()
metadata = json.loads((package / "package.json").read_text())
entry = package / metadata["bin"]["instar"]
node = shutil.which("node")
if not node or not entry.is_file() or not Path("/usr/bin/sandbox-exec").is_file():
    sys.exit("Requires Node, an installed release, and macOS sandbox-exec")


def run_case(fenced, project_dir=None):
    directory = nullcontext(project_dir) if project_dir else tempfile.TemporaryDirectory(prefix="journal-legacy-direct-")
    with directory as temporary:
        project = Path(temporary).resolve()
        journal = project / ".instar/state/coherence-journal"
        journal.mkdir(parents=True, exist_ok=True)
        before = {file.name: file.read_bytes() for file in journal.iterdir() if file.is_file()}
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        config = {
            "projectName": "journal-legacy-fixture",
            "port": port,
            "gitBackup": {"enabled": False},
            "tunnel": {"enabled": False},
            "multiMachine": {"coherenceJournal": {"enabled": True, "replication": {"enabled": False}}},
        }
        with (project / ".instar/config.json").open("x") as config_file:
            json.dump(config, config_file)
        rules = "(version 1)\n(allow default)\n(deny network*)\n"
        if fenced:
            rules += f"(deny file-write* (subpath {json.dumps(str(journal))}))\n"
        profile = project / "policy.sb"
        profile.write_text(rules)
        output = project / "server.log"
        environment = {"PATH": os.environ["PATH"], "HOME": str(project), "TMPDIR": str(project)}
        command = ["/usr/bin/sandbox-exec", "-f", str(profile), node, str(entry),
                   "server", "start", "--foreground", "--no-telegram", "--dir", str(project)]
        with output.open("wb") as log:
            child = subprocess.Popen(command, cwd=project, env=environment, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            captured = set()
            deadline = time.monotonic() + 25
            try:
                while time.monotonic() < deadline:
                    captured.update(file.name for file in journal.iterdir() if file.name not in before)
                    contents = output.read_text(errors="replace")
                    if child.poll() is not None or captured or (
                        fenced and journal_locked_out(contents)
                    ):
                        break
                    time.sleep(0.1)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        contents = output.read_text(errors="replace")
        print(f"release={metadata['version']} fenced={fenced} journal_files={sorted(captured)}")
        print("\n".join(line for line in contents.splitlines() if
                        "[coherence-journal]" in line)[-2800:])
        after = {file.name: file.read_bytes() for file in journal.iterdir() if file.is_file()}
        return captured, journal_locked_out(contents), before == after


def journal_locked_out(output):
    return any("[coherence-journal]" in line and "writer locked out" in line
               for line in output.splitlines())


if len(sys.argv) == 3:
    fixture_root = Path(sys.argv[2]).resolve(strict=True)
    if fixture_root.parent != Path(tempfile.gettempdir()).resolve() or not fixture_root.name.startswith("chief-journal-"):
        sys.exit("Expected a disposable chief-journal project")
    restricted_wrote, restricted_denied, unchanged = run_case(True, fixture_root)
    if restricted_wrote or not restricted_denied or not unchanged:
        sys.exit("Legacy process was not excluded from the existing journal")
else:
    control_wrote, _, _ = run_case(False)
    restricted_wrote, restricted_denied, _ = run_case(True)
    if not any(name.endswith(".lock") for name in control_wrote) or restricted_wrote or not restricted_denied:
        sys.exit("Legacy direct-entrypoint write exclusion was not established")
print("Fixture policy excluded the old direct process; production deployment of this policy is unproven.")
