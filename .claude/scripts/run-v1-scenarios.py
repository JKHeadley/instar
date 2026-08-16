#!/usr/bin/env python3
"""
run-v1-scenarios.py — test-driver-as-self for instar agents.

Drives a target agent via its /internal/telegram-forward HTTP endpoint
(acting as the user), then polls its /telegram/topics/:N/messages output
(acting as the developer). Reports pass/fail per scenario; exits non-zero
if any scenario fails.

Implements the "test-driver-as-self" standard: an instar developer
(e.g. echo) drives any other agent (e.g. deep-signal) end-to-end without
a human in the loop. Each scenario is a JSON file describing the steps;
the catalog directory is the authoritative manifest.

Usage:
  run-v1-scenarios.py \
    --target /Users/justin/Documents/Projects/deep-signal \
    --catalog /Users/justin/.instar/agents/echo/.instar/scenarios/v1.0.0 \
    [--port 5050] [--scenario <id>] [--verbose]

Scenario JSON shape:
  {
    "id": "...",
    "description": "...",
    "topic": 2525,
    "setup": [],
    "steps": [
      { "action": "assert-http", "endpoint": "/health", "status": 200,
        "bodyMatch": "ok" },
      { "action": "send-telegram", "text": "...",
        "fromFirstName": "Driver" },
      { "action": "wait-for-response", "timeoutMs": 60000,
        "matcher": "regex" },
      { "action": "assert-file", "path": ".instar/...", "exists": true },
      { "action": "sleep", "ms": 2000 }
    ],
    "teardown": []
  }
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def vlog(verbose: bool, msg: str) -> None:
    if verbose:
        sys.stderr.write(f"[driver] {msg}\n")


def http(method: str, url: str, auth: str, body: dict | None = None,
         timeout: float = 30.0) -> tuple[int, bytes]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {auth}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if hasattr(e, "read") else b""
    except urllib.error.URLError as e:
        return 0, str(e).encode()


def load_config(target: Path) -> dict:
    cfg_path = target / ".instar" / "config.json"
    if not cfg_path.exists():
        raise SystemExit(f"error: {cfg_path} not found — not an instar agent home")
    return json.loads(cfg_path.read_text())


def now_ms() -> int:
    return int(time.time() * 1000)


def step_send_telegram(step: dict, topic: int, base: str, auth: str,
                       verbose: bool, *, driver_bot_token: str | None = None,
                       chat_id: str | None = None,
                       via_telegram: bool = False) -> tuple[bool, str]:
    """
    Sends a message to the target. Two modes:

    - INJECTION (default): POST /internal/telegram-forward. Skips the
      Telegram network leg entirely; exercises every layer of the agent's
      processing pipeline as if a real Telegram message had been polled
      and forwarded.

    - VIA-TELEGRAM (--via-telegram on the CLI): POST to Telegram's
      sendMessage bot API using a driver bot token that must be a member
      of the target's chat. Exercises the full Telegram network leg +
      the target's polling loop + every downstream layer.

      The driver bot CANNOT be the target's own bot — Telegram polling
      filters out the bot's own messages. The driver bot must be a
      separate, dedicated test bot added to the chat with permission to
      post in the target's topic. Provision: BotFather → /newbot → add
      to chat → set `--driver-bot-token` and `--chat-id` on the CLI.
    """
    text = step["text"]
    from_first = step.get("fromFirstName", "Test User")
    synth_id = int(time.time()) * 100000 + random.randint(0, 99999)

    if via_telegram:
        if not driver_bot_token or not chat_id:
            return False, ("--via-telegram requires --driver-bot-token and "
                           "--chat-id (the driver bot must be a separate bot "
                           "that is a member of the target's chat — Telegram "
                           "polling filters out the target's own bot)")
        vlog(verbose, f"  send-telegram(via-telegram) topic={topic} text={text[:60]!r}...")
        # Telegram sendMessage payload. message_thread_id is required for
        # forum-style chats; chat_id is the supergroup id.
        tg_payload = {
            "chat_id": chat_id,
            "message_thread_id": topic,
            "text": text,
        }
        url = f"https://api.telegram.org/bot{driver_bot_token}/sendMessage"
        req = urllib.request.Request(url, data=json.dumps(tg_payload).encode(),
                                     method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=15.0) as resp:
                tg_body = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return False, f"telegram sendMessage HTTP {e.code}: {e.read()[:200]!r}"
        except urllib.error.URLError as e:
            return False, f"telegram sendMessage network error: {e}"
        if not tg_body.get("ok"):
            return False, f"telegram sendMessage not-ok: {tg_body}"
        vlog(verbose, f"    telegram sent: message_id={tg_body['result']['message_id']}")
        return True, ""

    payload = {
        "topicId": topic,
        "text": text,
        "fromUserId": 999999,
        "fromUsername": "v1scenario",
        "fromFirstName": from_first,
        "messageId": synth_id,
    }
    vlog(verbose, f"  send-telegram(injection) topic={topic} text={text[:60]!r}...")
    code, body = http("POST", f"{base}/internal/telegram-forward", auth,
                      body=payload, timeout=15.0)
    if code != 200:
        return False, f"forward returned {code}: {body[:200]!r}"
    vlog(verbose, f"    forward resp: {body[:120]!r}")
    return True, ""


# Sentinel/proxy/system message signatures. These messages are sent by the
# instar server itself (delivery acks, lifecycle events) or by the PresenceProxy
# standby monitor — NOT by the agent. A successful "agent replied" assertion
# must exclude them; otherwise a Codex-routed topic where the agent never
# called telegram-reply.sh will look green because the sentinel will fill the
# silence with "✷︎. 2-minute update" / "🔭 5-minute check" / "Session
# respawned." messages.
SENTINEL_SUBSTRINGS = (
    "✓ Delivered",
    "Session respawned.",
    "Session terminated.",
    "Session restarting",
    "Send a new message to start",
    "2-minute update",
    "5-minute check",
    "appears to be stuck",
    "Reply \"unstick\"",
    "Reply 'unstick'",
)
SENTINEL_PREFIX_CHARS = ("🔭", "✷")  # PresenceProxy default + customized prefixes


def is_sentinel_text(text: str) -> bool:
    """True when a message was emitted by a sentinel/proxy/system layer
    rather than by the agent itself. Mirrors the server's
    isSystemOrProxyMessage helper (src/messaging/shared/isSystemOrProxyMessage.ts)
    plus the PresenceProxy custom-prefix variants seen in the wild."""
    if not text:
        return True
    t = text.lstrip()
    if not t:
        return True
    for sub in SENTINEL_SUBSTRINGS:
        if sub in t:
            return True
    if t[0] in SENTINEL_PREFIX_CHARS:
        return True
    return False


def step_wait_for_response(step: dict, topic: int, base: str, auth: str,
                           pre_watermark: int, verbose: bool) -> tuple[bool, str]:
    timeout_ms = step.get("timeoutMs", 30000)
    matcher = step.get("matcher", "")
    # accept_sentinel: when True (rarely useful — only the polling-health
    # scenario does this), a sentinel-shaped message can satisfy the wait.
    # Default False so test-as-self correctly catches the "Codex never
    # replied, sentinel filled the gap" failure mode.
    accept_sentinel = bool(step.get("acceptSentinel", False))
    deadline = now_ms() + timeout_ms
    pat = re.compile(matcher) if matcher else None
    last_err = ""
    last_sentinel = ""
    while now_ms() < deadline:
        code, body = http("GET",
                          f"{base}/telegram/topics/{topic}/messages?limit=20",
                          auth, timeout=10.0)
        if code != 200:
            last_err = f"messages returned {code}"
            time.sleep(1)
            continue
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            last_err = f"messages body invalid json: {e}"
            time.sleep(1)
            continue
        msgs = data.get("messages", [])
        for m in msgs:
            try:
                mid = int(m.get("messageId", 0))
            except (TypeError, ValueError):
                continue
            if pre_watermark and mid <= pre_watermark:
                continue
            # Synthetic-user messages have timestamp-based mids; skip.
            if m.get("fromUser") is not False:
                continue
            text = m.get("text") or ""
            if not accept_sentinel and is_sentinel_text(text):
                # Track the last sentinel so the failure message can call
                # out "all you got was sentinel chatter" specifically.
                last_sentinel = text[:120]
                continue
            if pat and not pat.search(text):
                continue
            vlog(verbose, f"    matched mid={mid} text={text[:120]!r}")
            return True, ""
        time.sleep(2)
    reason = f"no matching agent response within {timeout_ms}ms (matcher={matcher!r}; last_err={last_err})"
    if last_sentinel:
        reason += f"; last sentinel message seen: {last_sentinel!r} — the agent itself never replied, only sentinels did"
    return False, reason


def step_assert_http(step: dict, base: str, auth: str,
                     verbose: bool) -> tuple[bool, str]:
    endpoint = step["endpoint"]
    expected_status = step.get("status", 200)
    expected_match = step.get("bodyMatch", "")
    code, body = http("GET", f"{base}{endpoint}", auth, timeout=10.0)
    if code != expected_status:
        return False, f"{endpoint} status {code} != expected {expected_status}"
    if expected_match and not re.search(expected_match, body.decode(errors="replace")):
        return False, f"{endpoint} body did not match /{expected_match}/"
    vlog(verbose, f"    assert-http ok: {endpoint} {code}")
    return True, ""


def step_assert_file(step: dict, target: Path,
                     verbose: bool) -> tuple[bool, str]:
    path = step["path"]
    full = target / path
    expects_exists = step.get("exists", True)
    actually_exists = full.exists()
    if expects_exists and not actually_exists:
        return False, f"expected file {full} to exist"
    if not expects_exists and actually_exists:
        return False, f"expected file {full} to NOT exist"
    vlog(verbose, f"    assert-file ok: {path} (exists={expects_exists})")
    return True, ""


def step_sleep(step: dict, verbose: bool) -> tuple[bool, str]:
    ms = step["ms"]
    vlog(verbose, f"    sleep {ms}ms")
    time.sleep(ms / 1000.0)
    return True, ""


def step_http_post(step: dict, base: str, auth: str,
                   verbose: bool) -> tuple[bool, str]:
    """POST JSON body to a target endpoint. Used by scenarios that need to
    flip topic state (framework routing, model selection, etc.) before
    exercising a send/wait pair."""
    endpoint = step["endpoint"]
    payload = step.get("body", {})
    expected_status = step.get("status", 200)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {auth}",
    }
    req = urllib.request.Request(
        f"{base}{endpoint}",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            code = resp.status
            body = resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        code = e.code
        body = e.read().decode(errors="replace") if e.fp else ""
    except urllib.error.URLError as e:
        return False, f"POST {endpoint}: connection error: {e}"
    if code != expected_status:
        return False, f"POST {endpoint} status {code} != expected {expected_status}: {body[:200]!r}"
    vlog(verbose, f"    http-post ok: {endpoint} {code}")
    return True, ""


STEP_HANDLERS = {
    "send-telegram": step_send_telegram,
    "wait-for-response": step_wait_for_response,
    "assert-http": step_assert_http,
    "assert-file": step_assert_file,
    "sleep": step_sleep,
    "http-post": step_http_post,
}


def get_watermark(topic: int, base: str, auth: str) -> int:
    """Return the highest agent-sent messageId currently in the topic."""
    code, body = http("GET",
                      f"{base}/telegram/topics/{topic}/messages?limit=50",
                      auth, timeout=10.0)
    if code != 200:
        return 0
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return 0
    highest = 0
    for m in data.get("messages", []):
        if m.get("fromUser") is not False:
            continue  # only count agent-sent messages as the watermark
        try:
            mid = int(m.get("messageId", 0))
        except (TypeError, ValueError):
            continue
        if mid > highest:
            highest = mid
    return highest


def run_scenario(scenario_path: Path, target: Path, base: str, auth: str,
                 verbose: bool, *,
                 driver_bot_token: str | None = None,
                 chat_id: str | None = None,
                 via_telegram: bool = False) -> tuple[bool, str]:
    scenario_id = scenario_path.stem.replace(".scenario", "")
    spec = json.loads(scenario_path.read_text())
    topic = spec.get("topic", 2525)
    vlog(verbose, f"scenario {scenario_id}: topic={topic}")
    pre_watermark = get_watermark(topic, base, auth)
    vlog(verbose, f"  pre-watermark messageId={pre_watermark}")

    for i, step in enumerate(spec.get("steps", [])):
        action = step.get("action")
        handler = STEP_HANDLERS.get(action)
        if handler is None:
            return False, f"step {i}: unknown action {action!r}"
        # Each handler has its own signature pattern; dispatch carefully.
        if action == "send-telegram":
            ok, err = handler(step, topic, base, auth, verbose,
                              driver_bot_token=driver_bot_token,
                              chat_id=chat_id,
                              via_telegram=via_telegram)
        elif action == "wait-for-response":
            ok, err = handler(step, topic, base, auth, pre_watermark, verbose)
        elif action == "assert-http":
            ok, err = handler(step, base, auth, verbose)
        elif action == "assert-file":
            ok, err = handler(step, target, verbose)
        elif action == "sleep":
            ok, err = handler(step, verbose)
        elif action == "http-post":
            ok, err = handler(step, base, auth, verbose)
        else:
            return False, f"step {i}: no dispatch for {action}"
        if not ok:
            return False, f"step {i} ({action}): {err}"
    return True, ""


def main() -> int:
    ap = argparse.ArgumentParser(description="Drive an instar agent end-to-end via scenario manifests.")
    ap.add_argument("--target", required=True, help="Target agent home directory (contains .instar/)")
    ap.add_argument("--catalog", required=True, help="Directory containing *.scenario.json files")
    ap.add_argument("--port", type=int, default=None, help="Server port (default: from target config)")
    ap.add_argument("--scenario", default=None, help="Run only this scenario id")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--via-telegram", action="store_true",
                    help="Send messages through Telegram's real bot API "
                         "instead of the target's /internal/telegram-forward "
                         "endpoint. Exercises the full Telegram network leg + "
                         "target's polling loop. Requires --driver-bot-token "
                         "(a separate bot that is a member of the target's "
                         "chat — the target's own bot is filtered out by its "
                         "polling loop) and --chat-id.")
    ap.add_argument("--driver-bot-token", default=None,
                    help="Bot token used to send messages via Telegram. Only "
                         "used with --via-telegram.")
    ap.add_argument("--chat-id", default=None,
                    help="Target's Telegram chat id. Default: read from "
                         "target's config.json.")
    args = ap.parse_args()

    target = Path(args.target).expanduser().resolve()
    catalog = Path(args.catalog).expanduser().resolve()
    if not (target / ".instar").is_dir():
        sys.stderr.write(f"error: {target} has no .instar/ — not an instar agent\n")
        return 2
    if not catalog.is_dir():
        sys.stderr.write(f"error: {catalog} is not a directory\n")
        return 2

    cfg = load_config(target)
    auth = cfg.get("authToken", "")
    if not auth:
        sys.stderr.write(f"error: no authToken in {target}/.instar/config.json\n")
        return 2
    port = args.port or cfg.get("port", 4040)
    base = f"http://localhost:{port}"

    # Resolve Telegram bits if --via-telegram.
    chat_id = args.chat_id
    if args.via_telegram and not chat_id:
        # Default: read from target's config.
        for m in cfg.get("messaging", []):
            if m.get("type") == "telegram":
                chat_id = m.get("config", {}).get("chatId")
                break
    if args.via_telegram and not args.driver_bot_token:
        sys.stderr.write(
            "error: --via-telegram requires --driver-bot-token "
            "(a separate bot, NOT the target's own bot — its polling loop "
            "filters its own messages out). See driver --help for setup.\n")
        return 2

    code, _ = http("GET", f"{base}/health", auth, timeout=5.0)
    if code == 0:
        sys.stderr.write(f"error: target server at {base} unreachable\n")
        return 2

    scenario_files = sorted(glob.glob(str(catalog / "*.scenario.json")))
    if not scenario_files:
        sys.stderr.write(f"error: no *.scenario.json in {catalog}\n")
        return 2

    total = passed = failed = 0
    failures: list[str] = []
    for f in scenario_files:
        sid = Path(f).stem.replace(".scenario", "")
        if args.scenario and args.scenario != sid:
            continue
        total += 1
        ok, err = run_scenario(Path(f), target, base, auth, args.verbose,
                                driver_bot_token=args.driver_bot_token,
                                chat_id=chat_id,
                                via_telegram=args.via_telegram)
        if ok:
            print(f"PASS {sid}")
            passed += 1
        else:
            print(f"FAIL {sid}: {err}", file=sys.stderr)
            failures.append(sid)
            failed += 1

    print()
    print("── Summary ──")
    print(f"  target:   {target} ({base})")
    print(f"  catalog:  {catalog}")
    print(f"  total:    {total}")
    print(f"  pass:     {passed}")
    print(f"  fail:     {failed}")
    if failed:
        print(f"  failures: {' '.join(failures)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
