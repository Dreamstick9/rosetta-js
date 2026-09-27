#!/usr/bin/env python3
"""Show everything about one UI component in one call: where it is defined,
its props, state/hooks/emits it uses, what it imports, who renders it, and
which tests cover it. Works for React (.jsx/.tsx), Vue SFCs and Svelte.

Usage: component_info.py NAME [DIR]
  NAME  component name (e.g. Counter) or a file path (src/Counter.vue)
  DIR   project root to search (default .). node_modules/dist/build are skipped.
"""
import os
import re
import sys

MAX_LINES = 40
EXTS = (".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".mjs")
SKIP = {"node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage", ".svelte-kit", "out"}


def walk(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP and not x.startswith(".")]
        for f in files:
            if f.endswith(EXTS):
                yield os.path.join(d, f)


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def find_definition(name, files):
    pats = [
        re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+%s\b" % name, re.M),
        re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+%s\s*(?::[^=]+)?=" % name, re.M),
        re.compile(r"^\s*(?:export\s+(?:default\s+)?)?class\s+%s\b" % name, re.M),
    ]
    hits = []
    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        if base == name and f.endswith((".vue", ".svelte")):
            hits.append((f, 1))
            continue
        text = read(f)
        for p in pats:
            m = p.search(text)
            if m:
                hits.append((f, text[:m.start()].count("\n") + 1))
                break
    hits.sort(key=lambda h: (".test." in h[0] or ".spec." in h[0] or ".stories." in h[0], len(h[0])))
    return hits


def props_of(path, text, name, line):
    out = []
    if path.endswith(".vue"):
        m = re.search(r"defineProps(?:<([^>]+)>)?\(([^)]*)\)", text, re.S)
        if m:
            out.append("props: " + " ".join((m.group(1) or m.group(2)).split())[:150])
        else:
            m = re.search(r"props\s*:\s*(\[[^\]]*\]|\{)", text)
            if m:
                out.append("props (options api): " + text[m.start():m.start() + 150].split("\n")[0])
        em = re.search(r"defineEmits(?:<([^>]+)>)?\(([^)]*)\)", text, re.S) or re.search(r"emits\s*:\s*(\[[^\]]*\])", text)
        if em:
            out.append("emits: " + " ".join((em.group(1) or em.group(em.lastindex) or "").split())[:120])
        return out
    if path.endswith(".svelte"):
        ps = re.findall(r"export\s+let\s+(\w+)(?:\s*=\s*([^;\n]+))?", text)
        if ps:
            out.append("props: " + ", ".join(p + ("=" + d.strip() if d else "") for p, d in ps)[:150])
        rp = re.search(r"\$props\(\)", text)
        if rp:
            out.append("props: svelte5 $props() — see: " + text[max(0, rp.start() - 60):rp.start()].split("\n")[-1].strip())
        return out
    lines = text.split("\n")
    sig = " ".join(lines[line - 1:line + 3])
    m = re.search(r"\(\s*(\{[^}]*\})\s*(?::\s*([\w<>\[\]]+))?", sig)
    if m:
        out.append("props: " + " ".join(m.group(1).split())[:140] + (" : " + m.group(2) if m.group(2) else ""))
    tm = re.search(r"(?:interface|type)\s+(%sProps|Props)\b[^{]*\{([^}]*)\}" % name, text, re.S)
    if tm:
        fields = [f.strip().rstrip(";,") for f in tm.group(2).split("\n") if f.strip() and not f.strip().startswith("//")]
        out.append("%s: %s" % (tm.group(1), "; ".join(fields)[:150]))
    pt = re.search(r"%s\.propTypes\s*=\s*\{([^}]*)\}" % name, text, re.S)
    if pt:
        out.append("propTypes: " + " ".join(pt.group(1).split())[:140])
    return out


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    target = args[0]
    root = args[1] if len(args) > 1 else "."
    files = list(walk(root))
    if os.path.isfile(target):
        name = os.path.splitext(os.path.basename(target))[0]
        defs = [(target, 1)] + [h for h in find_definition(name, files) if h[0] != target]
    else:
        name = target
        defs = find_definition(name, files)
    out = []
    if not defs:
        print("no definition of %s found under %s" % (name, root))
        return 1
    path, line = defs[0]
    text = read(path)
    out.append("definition: %s:%d" % (path, line))
    for other in defs[1:4]:
        out.append("  also: %s:%d" % other)
    out += props_of(path, text, name, line)
    hooks = sorted(set(re.findall(r"\b(use[A-Z]\w*|\$state|\$derived|\$effect|ref|reactive|computed|watch|onMounted)\s*\(", text)))
    if hooks:
        out.append("hooks/reactivity: " + ", ".join(hooks)[:150])
    imps = re.findall(r"^\s*import\s+(?:.+?\s+from\s+)?['\"]([^'\"]+)['\"]", text, re.M)
    if imps:
        out.append("imports: " + ", ".join(imps)[:200])
    handlers = sorted(set(re.findall(r"\b(on[A-Z]\w*)\s*=", text)) | set(re.findall(r"@(\w+)=", text)))
    if handlers:
        out.append("event props/handlers: " + ", ".join(handlers)[:150])
    use_rx = re.compile(r"<%s[\s/>]" % re.escape(name))
    imp_rx = re.compile(r"import\s+[^;]*\b%s\b[^;]*from" % re.escape(name))
    users, tests = [], []
    for f in files:
        if f == path:
            continue
        t = read(f)
        if name not in t:
            continue
        is_test = bool(re.search(r"\.(test|spec)\.|__tests__|/tests?/|/e2e/", f))
        if use_rx.search(t) or imp_rx.search(t):
            ln = next((i + 1 for i, s in enumerate(t.split("\n")) if use_rx.search(s)), 0)
            (tests if is_test else users).append("%s%s" % (f, ":%d" % ln if ln else ""))
    out.append("rendered/imported by (%d): %s" % (len(users), " ".join(users[:8]) or "-"))
    out.append("tests (%d): %s" % (len(tests), " ".join(tests[:6]) or "none — add one next to the component"))
    for line_ in out[:MAX_LINES]:
        print(line_)
    return 0


if __name__ == "__main__":
    sys.exit(main())
