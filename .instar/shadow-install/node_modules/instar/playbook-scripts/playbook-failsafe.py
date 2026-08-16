#!/usr/bin/env python3
"""
Playbook Failsafe — failure mode handling and degraded operation.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 3.7).

Implements:
  1. HMAC verification on manifest/governance reads with fallback
  2. Retry policy with exponential backoff + jitter
  3. Degraded mode detection and notification
  4. Scratchpad checksum verification

Failure Table (from spec):
| Failure                            | Degraded Mode                       | Recovery                              |
|------------------------------------|-------------------------------------|---------------------------------------|
| History HMAC chain failure         | HALT manifest writes, read-only     | Rebuild from snapshot + git           |
| Manifest HMAC signature failure    | Fall back to git-committed version  | Re-sign from history                  |
| Lifecycle crash mid-transaction    | Idempotent restart via ledger       | Re-run lifecycle                      |
| Embedding API downtime             | Skip deduplication cycle            | Retry on next run                     |
| Telegram notification failure      | Hold deltas below confidence        | Exponential backoff retry             |
| Scratchpad checksum failure        | Discard corrupt scratchpad          | Insights lost for that session        |
| Manifest missing/unparseable       | Explicit notification, no fallback  | Rebuild from history or git           |

Usage (library):
    from playbook_failsafe import verified_manifest_read, retry_with_backoff, DegradedMode

    manifest, mode = verified_manifest_read()
    if mode.is_degraded:
        print(f"Running in degraded mode: {mode.reason}")

    result = retry_with_backoff(some_api_call, max_attempts=5)

Usage (CLI):
    python3 playbook-failsafe.py status        # Check all failure modes
    python3 playbook-failsafe.py check-manifest # Verify manifest HMAC
    python3 playbook-failsafe.py check-chain    # Verify history chain
    python3 playbook-failsafe.py check-write    # Check if writes are safe
"""

import hashlib
import json
import os
import random
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
HISTORY_FILE = _paths.history
FAILSAFE_LOG = os.path.join(PROJECT_DIR, "context-failsafe.jsonl")

# Retry policy constants (from spec Section 3.7)
RETRY_BASE_SECONDS = 60
RETRY_MAX_DELAY_SECONDS = 1800  # 30 minutes
MAX_RETRY_ATTEMPTS = 5


class DegradedMode:
    """Represents a degraded operating mode."""

    def __init__(self, is_degraded=False, reason="", mode_type="normal",
                 can_write=True, alert_sent=False):
        self.is_degraded = is_degraded
        self.reason = reason
        self.mode_type = mode_type  # normal, read_only, fallback, explicit_degraded
        self.can_write = can_write
        self.alert_sent = alert_sent

    def to_dict(self):
        return {
            "is_degraded": self.is_degraded,
            "reason": self.reason,
            "mode_type": self.mode_type,
            "can_write": self.can_write,
            "alert_sent": self.alert_sent,
        }

    def __repr__(self):
        if not self.is_degraded:
            return "DegradedMode(normal)"
        return f"DegradedMode({self.mode_type}: {self.reason})"


def _log_failsafe_event(event_type, details):
    """Log a failsafe event to the failsafe log."""
    from atomic_write import atomic_append

    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event_type": event_type,
        "details": details,
    }
    atomic_append(FAILSAFE_LOG, json.dumps(entry, separators=(",", ":")))


def _send_telegram_alert(message):
    """Send a Telegram alert about degraded mode. Returns True if sent."""
    try:
        script = os.path.join(SCRIPT_DIR, "telegram-reply.py")
        if not os.path.exists(script):
            return False
        # Topic 7668 = development channel
        result = subprocess.run(
            ["python3", script, "7668"],
            input=message,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def _verify_manifest_hmac(manifest):
    """Verify the HMAC signature on a manifest. Returns (valid, error_msg)."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "playbook_hmac",
            os.path.join(SCRIPT_DIR, "playbook-hmac.py"))
        hmac_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hmac_mod)

        sig = manifest.get("hmac_signature", "")
        if not sig:
            return False, "No HMAC signature found"

        # Verify: remove sig, compute canonical, check
        manifest_copy = {k: v for k, v in manifest.items() if k != "hmac_signature"}
        canonical = json.dumps(manifest_copy, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        expected = hmac_mod.sign_content(canonical, hmac_mod.get_key())

        if sig == expected:
            return True, None
        return False, "HMAC signature mismatch"

    except Exception as e:
        return False, f"HMAC verification error: {e}"


def _get_git_manifest():
    """Get the last git-committed version of the manifest. Returns dict or None."""
    try:
        # Get the relative path from git root
        git_root_result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if git_root_result.returncode != 0:
            return None
        git_root = git_root_result.stdout.strip()
        rel_path = os.path.relpath(MANIFEST_FILE, git_root)

        result = subprocess.run(
            ["git", "show", f"HEAD:{rel_path}"],
            capture_output=True, text=True, timeout=5,
            cwd=git_root,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return None


def verified_manifest_read():
    """
    Read the manifest with HMAC verification and degraded mode handling.

    Returns (manifest, DegradedMode) tuple.

    Degraded modes per spec Section 3.7:
    - If HMAC fails: fall back to git-committed version
    - If manifest missing: explicit notification, no silent fallback
    - If manifest unparseable: explicit notification
    """
    # Check file exists
    if not os.path.exists(MANIFEST_FILE):
        _log_failsafe_event("manifest_missing", {"path": MANIFEST_FILE})
        alert_sent = _send_telegram_alert(
            "PLAYBOOK ALERT: context-manifest.json is missing. "
            "Running without Playbook context controls."
        )
        return None, DegradedMode(
            is_degraded=True,
            reason="Manifest file missing",
            mode_type="explicit_degraded",
            can_write=False,
            alert_sent=alert_sent,
        )

    # Try to read and parse
    try:
        with open(MANIFEST_FILE, "r") as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        _log_failsafe_event("manifest_unparseable", {"error": str(e)})
        alert_sent = _send_telegram_alert(
            f"PLAYBOOK ALERT: context-manifest.json unparseable: {e}. "
            "Running without Playbook context controls."
        )
        return None, DegradedMode(
            is_degraded=True,
            reason=f"Manifest unparseable: {e}",
            mode_type="explicit_degraded",
            can_write=False,
            alert_sent=alert_sent,
        )

    # Verify HMAC signature
    valid, error_msg = _verify_manifest_hmac(manifest)
    if valid:
        return manifest, DegradedMode()  # Normal mode

    # HMAC failed -- try git fallback
    _log_failsafe_event("manifest_hmac_failure", {
        "error": error_msg,
        "attempting_fallback": True,
    })

    git_manifest = _get_git_manifest()
    if git_manifest:
        # Verify git version's HMAC too
        git_valid, _ = _verify_manifest_hmac(git_manifest)
        if git_valid:
            alert_sent = _send_telegram_alert(
                f"PLAYBOOK DEGRADED: Manifest HMAC failure ({error_msg}). "
                "Fell back to git-committed version. Re-sign manifest to recover."
            )
            return git_manifest, DegradedMode(
                is_degraded=True,
                reason=f"HMAC failure: {error_msg}. Using git-committed version.",
                mode_type="fallback",
                can_write=False,
                alert_sent=alert_sent,
            )

    # Both current and git versions have HMAC issues -- use current but flag it
    alert_sent = _send_telegram_alert(
        f"PLAYBOOK DEGRADED: Manifest HMAC failure ({error_msg}). "
        "No valid git fallback available. Using unverified manifest."
    )
    return manifest, DegradedMode(
        is_degraded=True,
        reason=f"HMAC failure: {error_msg}. No valid fallback.",
        mode_type="explicit_degraded",
        can_write=False,
        alert_sent=alert_sent,
    )


def verify_history_chain():
    """
    Verify the HMAC chain integrity of context-history.jsonl.

    Returns (valid, break_point, total_entries).
    If invalid, break_point is the line number where the chain breaks.
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "playbook_verify",
            os.path.join(SCRIPT_DIR, "playbook-verify.py"))
        verify_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verify_mod)

        result = verify_mod.check_chain()
        # check_chain returns status: "pass"/"FAIL"/"skip" and valid: True/False
        if result.get("valid", False) or result.get("status") == "pass":
            return True, None, result.get("entries", 0)
        if result.get("status") == "skip":
            return True, None, 0  # No history file is OK
        return False, result.get("break_at"), result.get("entries", 0)

    except Exception as e:
        _log_failsafe_event("chain_verification_error", {"error": str(e)})
        return False, None, 0


def check_write_safety():
    """
    Check if it's safe to write to the manifest.

    Per spec: History HMAC chain failure -> HALT manifest writes.
    Returns (safe, DegradedMode).
    """
    valid, break_point, total = verify_history_chain()
    if valid:
        return True, DegradedMode()

    # Chain broken -- HALT manifest writes
    _log_failsafe_event("chain_broken_write_halt", {
        "break_point": break_point,
        "total_entries": total,
    })
    alert_sent = _send_telegram_alert(
        f"PLAYBOOK CRITICAL: History HMAC chain broken at entry {break_point}/{total}. "
        "Manifest writes HALTED. Sessions running read-only."
    )
    return False, DegradedMode(
        is_degraded=True,
        reason=f"History HMAC chain broken at entry {break_point}. Writes halted.",
        mode_type="read_only",
        can_write=False,
        alert_sent=alert_sent,
    )


def verify_scratchpad(session_id):
    """
    Verify scratchpad integrity for a session.

    Returns (valid, scratchpad_data_or_None).
    If checksum fails, discards corrupt data and returns None.
    """
    scratchpad_path = os.path.join(SESSIONS_DIR, session_id, "scratchpad.json")
    if not os.path.exists(scratchpad_path):
        return True, None  # No scratchpad is valid (just empty)

    try:
        with open(scratchpad_path, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        _log_failsafe_event("scratchpad_parse_error", {"session": session_id})
        return False, None

    # Check if scratchpad belongs to this session
    if data.get("session_id") != session_id:
        return True, None  # Different session's scratchpad, ignore

    # Verify checksum if present
    stored_checksum = data.get("checksum", "")
    if stored_checksum:
        # Compute checksum over content fields
        content = json.dumps(data.get("entries", []), sort_keys=True,
                             separators=(",", ":"), ensure_ascii=True)
        computed = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]

        if stored_checksum != computed:
            _log_failsafe_event("scratchpad_checksum_failure", {
                "session": session_id,
                "stored": stored_checksum,
                "computed": computed,
            })
            return False, None

    return True, data


def retry_with_backoff(fn, max_attempts=MAX_RETRY_ATTEMPTS, base=RETRY_BASE_SECONDS,
                       max_delay=RETRY_MAX_DELAY_SECONDS, on_retry=None):
    """
    Retry a function with exponential backoff and jitter.

    Implements spec retry policy (Section 3.7):
      delay = min(base * 2^attempt + random(0, base), max_delay)

    Args:
        fn: Callable to retry. Should raise on failure.
        max_attempts: Maximum retry attempts.
        base: Base delay in seconds.
        max_delay: Maximum delay in seconds.
        on_retry: Optional callback(attempt, delay, error) called before each retry.

    Returns the function's result on success.
    Raises the last exception on final failure.
    """
    last_error = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            last_error = e
            if attempt == max_attempts - 1:
                break

            jitter = random.uniform(0, base)
            delay = min(base * (2 ** attempt) + jitter, max_delay)

            if on_retry:
                on_retry(attempt + 1, delay, e)

            _log_failsafe_event("retry_attempt", {
                "attempt": attempt + 1,
                "delay_seconds": round(delay, 1),
                "error": str(e),
            })

            time.sleep(delay)

    raise last_error


def failsafe_status():
    """Get current failsafe status -- checks all failure modes."""
    results = {}

    # 1. Manifest HMAC
    manifest, mode = verified_manifest_read()
    results["manifest"] = {
        "available": manifest is not None,
        "degraded": mode.is_degraded,
        "mode": mode.mode_type,
        "reason": mode.reason if mode.is_degraded else None,
    }

    # 2. History chain
    valid, break_point, total = verify_history_chain()
    results["history_chain"] = {
        "valid": valid,
        "entries": total,
        "break_point": break_point,
    }

    # 3. Lock file
    lock_file = os.path.join(PROJECT_DIR, "context-manifest.lock")
    lock_exists = os.path.exists(lock_file)
    lock_stale = False
    if lock_exists:
        try:
            mtime = os.path.getmtime(lock_file)
            lock_stale = (time.time() - mtime) > 600
        except OSError:
            pass
    results["lock"] = {
        "exists": lock_exists,
        "stale": lock_stale,
    }

    # 4. Write safety
    safe, write_mode = check_write_safety()
    results["write_safety"] = {
        "safe": safe,
        "degraded": write_mode.is_degraded,
        "reason": write_mode.reason if write_mode.is_degraded else None,
    }

    # 5. Failsafe log recent events
    recent_events = []
    if os.path.exists(FAILSAFE_LOG):
        with open(FAILSAFE_LOG, "r") as f:
            lines = f.readlines()
        for line in lines[-5:]:
            try:
                recent_events.append(json.loads(line.strip()))
            except json.JSONDecodeError:
                pass
    results["recent_events"] = recent_events

    # Overall status
    all_ok = (
        results["manifest"]["available"]
        and not results["manifest"]["degraded"]
        and results["history_chain"]["valid"]
        and results["write_safety"]["safe"]
        and not results["lock"]["stale"]
    )
    results["overall"] = "healthy" if all_ok else "degraded"

    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "status":
        result = failsafe_status()
        print(json.dumps(result, indent=2))

    elif cmd == "check-manifest":
        manifest, mode = verified_manifest_read()
        if mode.is_degraded:
            print(f"DEGRADED: {mode.reason}")
            sys.exit(1)
        print(f"OK: Manifest verified ({len(manifest.get('items', []))} items)")

    elif cmd == "check-chain":
        valid, break_point, total = verify_history_chain()
        if valid:
            print(f"OK: History chain valid ({total} entries)")
        else:
            print(f"BROKEN: Chain breaks at entry {break_point}/{total}")
            sys.exit(1)

    elif cmd == "check-write":
        safe, mode = check_write_safety()
        if safe:
            print("OK: Writes are safe")
        else:
            print(f"HALTED: {mode.reason}")
            sys.exit(1)

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
