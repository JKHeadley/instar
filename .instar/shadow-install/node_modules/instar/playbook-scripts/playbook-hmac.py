#!/usr/bin/env python3
"""
Playbook HMAC Signing & Verification

Provides cryptographic integrity for Playbook context files:
- context-manifest.json (signed per-write)
- context-history.jsonl (HMAC-chained entries)
- context-governance.json (signed, human-only writes)

Key management:
- Keys stored in macOS Keychain under service 'playbook-hmac'
- Current key: 'playbook-hmac-v1' (rotated quarterly)
- Keys are NEVER stored in env vars, .env files, or repo files

Usage:
  python3 .claude/scripts/playbook-hmac.py init
  python3 .claude/scripts/playbook-hmac.py sign <file>
  python3 .claude/scripts/playbook-hmac.py verify <file> <hmac>
  python3 .claude/scripts/playbook-hmac.py chain-sign <json_str> <prev_hmac>
  python3 .claude/scripts/playbook-hmac.py chain-verify <json_str> <prev_hmac> <expected_hmac>
  python3 .claude/scripts/playbook-hmac.py rotate
  python3 .claude/scripts/playbook-hmac.py key-info
"""

import hashlib
import hmac as hmac_mod
import json
import os
import subprocess
import sys
import time


KEYCHAIN_SERVICE = "playbook-hmac"
KEYCHAIN_ACCOUNT_PREFIX = "playbook-hmac-v"
KEY_VERSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "playbook-key-version.json")


def _run_security_cmd(args):
    cmd = ["/usr/bin/security"] + args
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _get_current_key_version():
    if os.path.exists(KEY_VERSION_FILE):
        with open(KEY_VERSION_FILE, "r") as f:
            data = json.load(f)
            return data.get("current_version", 1)
    return 1


def _set_key_version(version, rotated_at=None):
    data = {
        "current_version": version,
        "rotated_at": rotated_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version_history": [],
    }
    if os.path.exists(KEY_VERSION_FILE):
        with open(KEY_VERSION_FILE, "r") as f:
            existing = json.load(f)
            data["version_history"] = existing.get("version_history", [])

    data["version_history"].append({
        "version": version,
        "created_at": data["rotated_at"],
    })

    with open(KEY_VERSION_FILE, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def get_key(version=None):
    if version is None:
        version = _get_current_key_version()

    account = f"{KEYCHAIN_ACCOUNT_PREFIX}{version}"
    rc, stdout, stderr = _run_security_cmd([
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w",
    ])

    if rc != 0:
        print(f"Error: Key '{account}' not found in Keychain.", file=sys.stderr)
        print(f"Run: python3 {__file__} init", file=sys.stderr)
        sys.exit(1)

    return bytes.fromhex(stdout)


def store_key(key_hex, version):
    account = f"{KEYCHAIN_ACCOUNT_PREFIX}{version}"
    _run_security_cmd(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
    rc, stdout, stderr = _run_security_cmd([
        "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", key_hex, "-T", "",
    ])
    if rc != 0:
        print(f"Error storing key: {stderr}", file=sys.stderr)
        sys.exit(1)


def generate_key():
    return os.urandom(32).hex()


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sign_content(content, key):
    if isinstance(content, str):
        content = content.encode("utf-8")
    return hmac_mod.new(key, content, hashlib.sha256).hexdigest()


def verify_content(content, key, expected):
    actual = sign_content(content, key)
    return hmac_mod.compare_digest(actual, expected)


def sign_file(file_path):
    key = get_key()
    with open(file_path, "rb") as f:
        content = f.read()
    return sign_content(content, key)


def verify_file(file_path, expected):
    key = get_key()
    with open(file_path, "rb") as f:
        content = f.read()
    return verify_content(content, key, expected)


def chain_sign(json_str, prev_hmac):
    key = get_key()
    chained = prev_hmac + json_str
    return sign_content(chained, key)


def chain_verify(json_str, prev_hmac, expected):
    key = get_key()
    chained = prev_hmac + json_str
    return verify_content(chained, key, expected)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "init":
        version = 1
        key_hex = generate_key()
        store_key(key_hex, version)
        _set_key_version(version)
        print(f"HMAC key v{version} generated and stored in macOS Keychain.")
        print(f"Service: {KEYCHAIN_SERVICE}, Account: {KEYCHAIN_ACCOUNT_PREFIX}{version}")

    elif cmd == "sign":
        if len(sys.argv) < 3:
            print("Usage: playbook-hmac.py sign <file>", file=sys.stderr)
            sys.exit(1)
        print(sign_file(sys.argv[2]))

    elif cmd == "verify":
        if len(sys.argv) < 4:
            print("Usage: playbook-hmac.py verify <file> <hmac>", file=sys.stderr)
            sys.exit(1)
        if verify_file(sys.argv[2], sys.argv[3]):
            print("VALID")
        else:
            print("INVALID", file=sys.stderr)
            sys.exit(1)

    elif cmd == "chain-sign":
        if len(sys.argv) < 4:
            print("Usage: playbook-hmac.py chain-sign <json_str> <prev_hmac>", file=sys.stderr)
            sys.exit(1)
        print(chain_sign(sys.argv[2], sys.argv[3]))

    elif cmd == "chain-verify":
        if len(sys.argv) < 5:
            print("Usage: playbook-hmac.py chain-verify <json_str> <prev_hmac> <expected>", file=sys.stderr)
            sys.exit(1)
        if chain_verify(sys.argv[2], sys.argv[3], sys.argv[4]):
            print("VALID")
        else:
            print("INVALID", file=sys.stderr)
            sys.exit(1)

    elif cmd == "rotate":
        old_v = _get_current_key_version()
        new_v = old_v + 1
        key_hex = generate_key()
        store_key(key_hex, new_v)
        _set_key_version(new_v)
        print(f"Rotated: v{old_v} -> v{new_v}")
        print("Old key retained. Re-sign all active manifest items with new key.")

    elif cmd == "key-info":
        version = _get_current_key_version()
        account = f"{KEYCHAIN_ACCOUNT_PREFIX}{version}"
        rc, _, _ = _run_security_cmd(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
        print(f"Version: v{version} | Status: {'FOUND' if rc == 0 else 'MISSING'}")
        if os.path.exists(KEY_VERSION_FILE):
            with open(KEY_VERSION_FILE, "r") as f:
                data = json.load(f)
                for h in data.get("version_history", [])[-3:]:
                    print(f"  v{h['version']} created {h['created_at']}")

    elif cmd == "canonical-json":
        data = json.load(sys.stdin)
        print(canonical_json(data))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
