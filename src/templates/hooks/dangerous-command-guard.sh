#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Part of instar's "Security Through Identity" model.
#
# Supports two safety levels (configured in .instar/config.json → safety.level):
#
#   Level 1 (default): Block risky commands and tell the agent to ask the user.
#     → Safe starting point. Human stays in the loop. Trust builds over time.
#
#   Level 2 (autonomous): Inject a self-verification prompt instead of blocking.
#     → Agent reasons about whether the action is correct before proceeding.
#     → Enables fully hands-off operation while maintaining intelligent safety.
#     → Truly catastrophic commands (rm -rf /, fork bombs) are ALWAYS blocked.
#
# The progression from Level 1 → Level 2 is the path to full autonomy.
# The agent isn't blindly executing — it's running an intelligent self-check
# before every sensitive action. The hook makes this structural, not optional.
#
# Installed by instar during setup. Runs as a Claude Code PreToolUse hook on Bash.

INPUT="$1"
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

# --- Read safety level from config ---
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# --- ALWAYS blocked (regardless of safety level) ---
# These are catastrophic, irreversible operations that no self-check can undo.
ALWAYS_BLOCK_PATTERNS=(
  "rm -rf /"
  "rm -rf ~"
  "> /dev/sda"
  "mkfs\."
  "dd if="
  ":(){:|:&};:"
  # Database schema destruction — these flags/commands exist specifically to bypass
  # safety checks. Treat them as catastrophic regardless of context.
  # (Learned from Portal production data loss incident 2026-02-22)
  "--accept-data-loss"
  "prisma migrate reset"
)

for pattern in "${ALWAYS_BLOCK_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi -e "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "This command is always blocked regardless of safety level." >&2
    echo "If you genuinely need to run this, the user must execute it directly." >&2
    exit 2
  fi
done

# A literal credential on a command line is readable by every process on this machine through ps for
# as long as the command runs, and process samplers (diagnostics, crash captures) record it
# (argv-token incident, 2026-11-17). Read the secret inside the command instead; the shell expands it
# and it never reaches the command line. Always blocked, regardless of safety level.
if echo "$INPUT" | grep -qE -e '(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[abprs]-[0-9A-Za-z-]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33})'; then
  echo 'BLOCKED: this command carries a literal credential (a token, an API key or a bot token).' >&2
  echo 'A command line is visible to every process on this machine while it runs. Read the secret inside the command instead, for example GH_TOKEN="$(gh auth token)" or pass a vault value with secret-get.mjs NAME --run -- COMMAND. To write a file that holds a fixture, use the Write tool.' >&2
  exit 2
fi

# SQL context: only proven literal data operations bypass the SQL-shaped matcher.
sql_command_is_literal_data() {
  python3 - "$INPUT" <<'INSTAR_SQL_CONTEXT_PY'
import ast, json, os, re, shlex, sys

def active_expansion(source):
    quote = None
    i = 0
    while i < len(source):
        c = source[i]
        if quote == "'":
            if c == "'": quote = None
        elif c == '\\':
            return True
        elif c == "'" and quote is None:
            quote = "'"
        elif c == '"':
            quote = None if quote == '"' else '"'
        elif ord(c) == 96 or c == '$':
            return True
        elif quote is None and c in '*?[{~#':
            return True
        elif quote is None and (source.startswith('<(', i) or source.startswith('>(', i)):
            return True
        i += 1
    return quote is not None

def tokens(source, posix=True):
    lexer = shlex.shlex(source, posix=posix, punctuation_chars=';&|()<>\n')
    lexer.whitespace = ' \t\r'
    lexer.commenters = ''
    return list(lexer)

def quoted_operator(source):
    for raw in tokens(source, posix=False):
        if raw and raw[0] in ("'", '"'):
            values = shlex.split(raw, posix=True)
            if len(values) == 1 and values[0] and all(c in ';&|()<>\n' for c in values[0]): return True
    return False

def python_file_data(source):
    tree = ast.parse(source)
    if len(list(ast.walk(tree))) > 4096: return False
    bindings = {}
    constructors = set()

    def kind(node):
        if isinstance(node, ast.Constant):
            return 'text' if isinstance(node.value, str) else 'bytes' if isinstance(node.value, bytes) else 'number' if isinstance(node.value, (int, float)) else None
        if isinstance(node, ast.Name): return bindings.get(node.id)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = kind(node.left), kind(node.right)
            return left if left == right and left in ('text', 'bytes') else None
        if not isinstance(node, ast.Call) or any(k.arg is None for k in node.keywords): return None
        if isinstance(node.func, ast.Name) and node.func.id == 'Path' and 'Path' in constructors:
            return 'path' if node.args and all(kind(a) == 'text' for a in node.args) and not node.keywords else None
        if isinstance(node.func, ast.Attribute):
            owner, method = node.func.value, node.func.attr
            if isinstance(owner, ast.Name) and owner.id == 'pathlib' and 'pathlib' in constructors and method == 'Path':
                return 'path' if node.args and all(kind(a) == 'text' for a in node.args) and not node.keywords else None
            receiver = kind(owner)
            args = [kind(a) for a in node.args]
            if any(kind(k.value) != 'text' or k.arg not in ('encoding', 'errors') for k in node.keywords): return None
            if receiver == 'path':
                if method == 'read_text' and not args: return 'text'
                if method == 'read_bytes' and not args and not node.keywords: return 'bytes'
                if method == 'write_text' and args == ['text']: return 'number'
                if method == 'write_bytes' and args == ['bytes'] and not node.keywords: return 'number'
            if receiver == 'text' and method == 'replace' and args == ['text', 'text'] and not node.keywords: return 'text'
        return None

    for statement in tree.body:
        if isinstance(statement, ast.ImportFrom) and statement.module == 'pathlib' and statement.level == 0:
            if any(a.name != 'Path' or a.asname for a in statement.names): return False
            constructors.add('Path')
        elif isinstance(statement, ast.Import):
            if any(a.name != 'pathlib' or a.asname for a in statement.names): return False
            constructors.add('pathlib')
        elif isinstance(statement, ast.Assign):
            value = kind(statement.value)
            if value is None or any(not isinstance(t, ast.Name) or t.id in ('Path', 'pathlib') for t in statement.targets): return False
            for target in statement.targets: bindings[target.id] = value
        elif isinstance(statement, ast.Expr):
            if kind(statement.value) is None: return False
        else: return False
    return True

def safe_command(raw, depth):
    values = list(raw)
    # Environment overrides can change a tool's execution configuration.
    if values and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', values[0]): return False
    if not values: return True
    if values[0] == 'command':
        values.pop(0)
        if values and values[0] == '--': values.pop(0)
    if not values: return False
    name = os.path.basename(values[0])
    args = values[1:]
    if name in ('sh', 'bash'):
        if os.environ.get('BASH_ENV') or os.environ.get('ENV'): return False
        return len(args) == 2 and args[0] == '-c' and data_only(args[1], depth + 1)
    if name in ('python', 'python3'):
        return len(args) == 2 and args[0] == '-c' and python_file_data(args[1])
    if name == 'rg' and (os.environ.get('RIPGREP_CONFIG_PATH') or any(a == '--pre' or a.startswith('--pre=') or a == '--hostname-bin' or a.startswith('--hostname-bin=') for a in args)): return False
    if name == 'printf' and any(a.startswith('-v') for a in args): return False
    return name in ('rg', 'grep', 'egrep', 'fgrep', 'cat', 'printf', 'echo', 'tee', 'head', 'tail', 'wc', 'true', 'false')

def safe_tokens(parts, depth):
    command = []
    i = 0
    for_end = (';', '&&', '||', '|', '&', '\n')
    while i < len(parts):
        token = parts[i]
        if token in for_end:
            if command and not safe_command(command, depth): return False
            command = []
        elif token in ('>', '>>', '<'):
            i += 1
            if i >= len(parts) or parts[i] in for_end or parts[i] in ('(', ')', '<', '>', '>>', '<<'): return False
        elif token and all(c in ';&|()<>\n' for c in token):
            return False
        else: command.append(token)
        i += 1
    return not command or safe_command(command, depth)

def data_only(source, depth=0):
    if depth > 8 or len(source) > 262144: return False
    if any((ord(c) < 32 and c not in ('\n', '\t')) or ord(c) in (127, 133, 8232, 8233) for c in source): return False
    lines = source.splitlines(keepends=True)
    first = tokens(lines[0].rstrip('\r\n')) if lines else []
    if '<<' in first:
        # Raw anchoring rejects quote concatenation and unsupported headers;
        # semantic argv alone does not retain heredoc quoting provenance.
        header = re.fullmatch(r'''[ \t]*(cat|tee|python3?)(?:[ \t]+-)?[ \t]*<<[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*(?:>>?[ \t]*[A-Za-z0-9_./-]+[ \t]*)?''', lines[0].rstrip('\n'))
        if header is None: return False
        marker = header.group(3)
        end = next((n for n in range(1, len(lines)) if lines[n].rstrip('\r\n') == marker), None)
        if end is None: return False
        body = ''.join(lines[1:end])
        name = header.group(1)
        if name in ('python', 'python3'):
            if not python_file_data(body): return False
        return data_only(''.join(lines[end + 1:]), depth + 1)
    return not active_expansion(source) and not quoted_operator(source) and safe_tokens(tokens(source), depth)

try:
    source = sys.argv[1]
    try:
        payload = json.loads(source)
        if isinstance(payload, dict):
            tool = payload.get('tool_input')
            if tool is not None and not isinstance(tool, dict): sys.exit(1)
            candidates = []
            for container in (payload, tool or {}):
                for field in ('command', 'cmd'):
                    value = container.get(field)
                    if value is not None and value != '':
                        if not isinstance(value, str): sys.exit(1)
                        candidates.append(value)
            if len(set(candidates)) > 1: sys.exit(1)
            source = candidates[0] if candidates else ''
    except (ValueError, TypeError): pass
    sys.exit(0 if isinstance(source, str) and data_only(source) else 1)
except Exception:
    sys.exit(1)
INSTAR_SQL_CONTEXT_PY
}
SQL_LITERAL_DATA=""

# --- Risky commands: behavior depends on safety level ---
RISKY_PATTERNS=(
  "rm -rf \."
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git clean -fd"
  # Flags and global options can sit anywhere: a -q before the hard flag, git -C <path>, clean -xfd, push origin x -f.
  "git +([^|;&]* +)?reset +([^|;&]* +)?--hard"
  "git +([^|;&]* +)?clean +([^|;&]* +)?(-[a-zA-Z]*f|--force)"
  "git +([^|;&]* +)?push +([^|;&]* +)?(--force|-f)([^a-zA-Z0-9-]|$)"
  "DROP TABLE"
  "DROP DATABASE"
  "TRUNCATE"
  "DELETE FROM"
  # Schema push against production — "non-destructive" additions can silently
  # drop tables when schema/DB naming conventions are inconsistent.
  # Use SQL ALTER TABLE for targeted production changes instead.
  "prisma db push"
  "prisma migrate deploy"
)

# --- Safe-case carve-out: `git push --force-with-lease` to a NON-protected branch ---
# `--force-with-lease` is the SAFE force-push: it refuses to overwrite work the
# local clone hasn't seen. To one's OWN feature/PR branch (not shared history)
# this is the legitimate way to update an amended/rebased branch — and a recurring
# friction when the guard blocks it (a dev session resolving its own PR). We allow
# ONLY this narrow case. We still block:
#   - plain `--force` / `-f` (no lease) — always risky,
#   - any force-push that explicitly targets a protected branch (main/master/
#     develop/release*).
# Residual edge (force-with-lease while checked out ON main, no branch named) is
# double-protected: agents work in worktrees on feature branches (never main), and
# main carries remote branch protection that rejects a force-push regardless.
FORCE_WITH_LEASE_OWN_BRANCH=0
if echo "$INPUT" | grep -qiE 'git +push[^|;&]*--force-with-lease'; then
  # Scan ONLY the `git push …` invocation for a protected branch — NOT the whole
  # $INPUT. The previous whole-$INPUT scan false-positived on any unrelated text in the
  # command (e.g. a heredoc status message mentioning "release cadence" or "main"),
  # blocking a legitimate PR-branch force-with-lease update — the recurring friction
  # the carve-out exists to remove (2026-06-07, topic 19437). Isolating to the push
  # invocation keeps the main/master/release block precise.
  PUSH_INVOCATION=$(echo "$INPUT" | grep -oiE 'git +push[^|;&]*' | head -1)
  if echo "$PUSH_INVOCATION" | grep -qiE '(^|[[:space:]:/])(main|master|develop|release[A-Za-z0-9._/-]*)([[:space:]]|:|$)'; then
    FORCE_WITH_LEASE_OWN_BRANCH=0   # explicit protected target in the push command — keep blocking
  else
    FORCE_WITH_LEASE_OWN_BRANCH=1   # safe: force-with-lease to a non-protected branch
  fi
fi

for pattern in "${RISKY_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qiE -e "$pattern"; then
    case "$pattern" in
      "D""ROP TABLE"|"D""ROP DATABASE"|"T""RUNCATE"|"D""ELETE FROM")
        if [ -z "$SQL_LITERAL_DATA" ]; then
          if sql_command_is_literal_data; then SQL_LITERAL_DATA=1; else SQL_LITERAL_DATA=0; fi
        fi
        if [ "$SQL_LITERAL_DATA" = "1" ]; then continue; fi
        ;;
    esac
    # Allow the safe force-with-lease-to-own-branch case past the force-push patterns.
    if [ "$FORCE_WITH_LEASE_OWN_BRANCH" -eq 1 ] && echo "$pattern" | grep -qiE 'git push (--force|-f)'; then
      continue
    fi
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      # Level 1: Block and require authorization — agent executes after user confirms
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      # Level 2: Inject self-verification prompt (don't block)
      # The agent must reason about whether this action is correct.
      AGENT_IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        AGENT_IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md")
      fi

      VERIFICATION=$(cat <<VERIFY
{
  "decision": "approve",
  "additionalContext": "=== SELF-VERIFICATION REQUIRED ===\nA potentially destructive command was detected: $pattern\n\nBefore proceeding, verify:\n1. Is this command necessary for the current task?\n2. Have you considered the consequences if this goes wrong?\n3. Is there a safer alternative that achieves the same result?\n4. Does this align with your principles and the user's intent?\n\nYour identity:\n$AGENT_IDENTITY\n\nIf ALL checks pass, proceed. If ANY check fails, stop and reconsider.\n=== END SELF-VERIFICATION ==="
}
VERIFY
)
      echo "$VERIFICATION"
      exit 0
    fi
  fi
done
