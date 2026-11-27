/** Shared by new and updated hook writers. Unknown syntax keeps the SQL check. */
export const SQL_COMMAND_CONTEXT_CHECK = String.raw`# SQL context: only proven literal data operations bypass the SQL-shaped matcher.
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
`;
