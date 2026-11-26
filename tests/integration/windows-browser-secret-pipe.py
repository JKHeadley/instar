"""Run from WSL with an interactive Windows user: python3 tests/integration/windows-browser-secret-pipe.py.

Uses an isolated agent and a synthetic driver. No browser is opened.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
WRAPPER = Path(__file__).resolve().parents[2] / 'src/templates/scripts/browser/ndrive.sh'


def prove_secret_transport(root, win_dir):
    browser = root / '.instar/scripts/browser'
    browser.mkdir(parents=True)
    driver = browser / 'ndrive.sh'
    shutil.copyfile(WRAPPER, driver)
    fixture = win_dir / 'fixture-driver.ps1'
    secret = ('synthetic-' + uuid.uuid4().hex + '-!$%&').encode()
    expected = hashlib.sha256(secret).hexdigest()
    fixture.write_text("""param([string]$cmd,[string]$arg)
$ErrorActionPreference='Stop'
if ($cmd -notin @('typesecret','typesecretedit')) { exit 64 }
if ($cmd -eq 'typesecretedit' -and $arg -ne '0') { exit 65 }
$value=[Console]::In.ReadLine()
$hex=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($value))).Replace('-','').ToLowerInvariant()
if ([Environment]::CommandLine.Contains($value)) { exit 67 }
if ($hex -ne '""" + expected + """') { exit 66 }
Start-Sleep -Seconds 4
[Console]::Out.WriteLine($value)
[Console]::Error.WriteLine($value)
exit 0
""")
    tag = root.name + '-' + hashlib.sha256(str(root).encode()).hexdigest()[:8]
    bridge = win_dir.parent / 'native-drive' / ('instar-' + tag) / 'bridge'
    fixture_path = subprocess.check_output(['wslpath', '-w', str(fixture)], text=True).strip()
    env = dict(os.environ, ND_BRIDGE='task', ND_SCRIPT=fixture_path, ND_BRIDGE_TIMEOUT='40')
    seen_files = set()
    disk_hits = set()
    with subprocess.Popen(
        ['bash', str(driver), 'typesecretedit', '0'], cwd=root, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as process:
        process.stdin.write(secret + b'\n')
        process.stdin.close()
        deadline = time.monotonic() + 55
        while process.poll() is None:
            if time.monotonic() > deadline:
                process.kill()
                raise TimeoutError('Windows driver did not report within 55 seconds')
            for file in bridge.glob('*/*'):
                try:
                    contents = file.read_bytes()
                except (FileNotFoundError, IsADirectoryError):
                    continue
                seen_files.add(file.name)
                if secret in contents:
                    disk_hits.add(file.name)
            time.sleep(0.08)
        stdout = process.stdout.read()
        stderr = process.stderr.read()

    output = {
        'exitCode': process.returncode,
        'sawRunner': 'runner.ps1' in seen_files,
        'sawDriverPid': 'pid.txt' in seen_files,
        'legacyStdinFile': 'stdin.txt' in seen_files,
        'diskHits': sorted(disk_hits),
        'secretInCapturedOutput': secret in stdout + stderr,
        'fixedSuccessMarker': b'typed secret' in stdout,
    }
    print(json.dumps(output))
    assert process.returncode == 0 and output['sawRunner'] and output['sawDriverPid']
    assert not output['legacyStdinFile'] and not disk_hits and not output['secretInCapturedOutput']
    assert output['fixedSuccessMarker']


os.umask(0o077)
windows_home = subprocess.check_output(
    [POWERSHELL, '-NoProfile', '-Command', '$env:LOCALAPPDATA'], text=True, timeout=10
).strip()
windows_local = Path(subprocess.check_output(['wslpath', '-u', windows_home], text=True).strip())

with tempfile.TemporaryDirectory(prefix='ndrive-pipe-') as test_home, tempfile.TemporaryDirectory(
    prefix='ndrive-pipe-', dir=windows_local
) as windows_fixture_home:
    prove_secret_transport(Path(test_home), Path(windows_fixture_home))
