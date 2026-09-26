#!/usr/bin/env python3
"""Map a Cargo project in one call: workspace members, each crate's targets,
features, internal deps and test counts, the toolchain, offline/vendoring
status, cfg(feature) names used in code but never declared, and the exact
test command. With --for FILE: the crate, module path and test command for it.

usage:
  crate_map.py [DIR]              map the workspace (default: .)
  crate_map.py [DIR] --for FILE   which crate/module owns FILE, how to test it
"""
import argparse
import glob
import os
import re
import sys

SKIP = {"target", ".git", "vendor", "node_modules", ".cargo"}


# ---- tiny TOML subset (used when tomllib is missing, Python < 3.11) ----
def _val(s, i):
    while i < len(s) and s[i] in " \t\r\n,":
        i += 1
    c = s[i] if i < len(s) else ""
    if s.startswith('"""', i) or s.startswith("'''", i):
        q = s[i:i + 3]
        j = s.index(q, i + 3)
        return s[i + 3:j], j + 3
    if c in "\"'":
        j = i + 1
        while j < len(s) and s[j] != c:
            j += 2 if (c == '"' and s[j] == "\\") else 1
        return s[i + 1:j], j + 1
    if c == "[":
        out, i = [], i + 1
        while True:
            while i < len(s) and s[i] in " \t\r\n,":
                i += 1
            if i >= len(s) or s[i] == "]":
                return out, i + 1
            if s[i] == "#":
                i = s.find("\n", i)
                continue
            v, i = _val(s, i)
            out.append(v)
    if c == "{":
        out, i = {}, i + 1
        while True:
            while i < len(s) and s[i] in " \t\r\n,":
                i += 1
            if i >= len(s) or s[i] == "}":
                return out, i + 1
            m = re.compile(r'\s*("?[\w.\-]+"?)\s*=\s*').match(s, i)
            if not m:
                return out, len(s)
            v, i = _val(s, m.end())
            _set(out, m.group(1).strip('"').split("."), v)
    m = re.compile(r"[^,\]\}\n#]+").match(s, i)
    raw = m.group(0).strip() if m else ""
    return {"true": True, "false": False}.get(raw, raw), (m.end() if m else i + 1)


def _set(d, keys, v):
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = v


def toml_load(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    try:
        import tomllib
        return tomllib.loads(text)
    except Exception:
        pass
    root, cur, i = {}, None, 0
    cur = root
    while i < len(text):
        m = re.compile(r"[ \t]*(\[\[?)\s*([^\]]+?)\s*\]\]?[^\n]*\n?").match(text, i)
        if m and text[i:].lstrip(" \t").startswith("["):
            keys = [k.strip().strip('"') for k in m.group(2).split(".")]
            if m.group(1) == "[[":
                parent = root
                for k in keys[:-1]:
                    parent = parent.setdefault(k, {})
                lst = parent.setdefault(keys[-1], [])
                cur = {}
                lst.append(cur)
            else:
                cur = root
                for k in keys:
                    cur = cur.setdefault(k, {})
            i = m.end()
            continue
        m = re.compile(r'[ \t]*("[^"]+"|[\w.\-]+)[ \t]*=[ \t]*').match(text, i)
        if m:
            v, i = _val(text, m.end())
            _set(cur, [k.strip('"') for k in re.findall(r'"[^"]+"|[^.]+', m.group(1))], v)
            nl = text.find("\n", i)
            i = len(text) if nl < 0 else nl + 1
            continue
        nl = text.find("\n", i)
        i = len(text) if nl < 0 else nl + 1
    return root


# ---- project scan ----
def rs_files(d):
    for base, dirs, files in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        if base != d and os.path.exists(os.path.join(base, "Cargo.toml")):
            dirs[:] = []
            continue
        for f in sorted(files):
            if f.endswith(".rs"):
                yield os.path.join(base, f)


def crate_info(root, cdir):
    t = toml_load(os.path.join(cdir, "Cargo.toml"))
    pkg = t.get("package") or {}
    name = pkg.get("name") or os.path.basename(cdir)
    kinds = []
    if os.path.exists(os.path.join(cdir, "src/lib.rs")) or "lib" in t:
        kinds.append("lib")
    bins = [b.get("name", "?") for b in t.get("bin", []) if isinstance(b, dict)]
    if os.path.exists(os.path.join(cdir, "src/main.rs")) and name not in bins:
        bins.insert(0, name)
    bins += [os.path.splitext(os.path.basename(p))[0]
             for p in sorted(glob.glob(os.path.join(cdir, "src/bin/*.rs")))]
    bins = sorted(set(bins), key=bins.index)
    if bins:
        kinds.append("bin:" + ",".join(bins[:4]))
    itests = sorted(os.path.splitext(os.path.basename(p))[0]
                    for p in glob.glob(os.path.join(cdir, "tests/*.rs")))
    feats = t.get("features") or {}
    deps = {}
    for sect in ("dependencies", "dev-dependencies", "build-dependencies"):
        for k, v in (t.get(sect) or {}).items():
            deps[k] = v
    optional = [k for k, v in deps.items() if isinstance(v, dict) and v.get("optional")]
    local = [k for k, v in deps.items() if isinstance(v, dict) and "path" in v]
    ntests, used = 0, {}
    for f in rs_files(cdir):
        try:
            src = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        ntests += len(re.findall(r"#\[(?:\w+::)?test\b", src))
        for m in re.finditer(r'feature\s*=\s*"([^"]+)"', src):
            used.setdefault(m.group(1), "%s:%d" % (os.path.relpath(f, root),
                                                  src.count("\n", 0, m.start()) + 1))
    declared = set(feats) | set(optional) | {"default"}
    undeclared = {k: v for k, v in used.items() if k not in declared}
    ed = pkg.get("edition", "")
    if isinstance(ed, dict):
        ed = "workspace"
    return {"name": name, "dir": os.path.relpath(cdir, root), "kinds": kinds, "itests": itests,
            "feats": feats, "optional": optional, "local": local, "ntests": ntests,
            "undeclared": undeclared, "edition": ed}


def members(root):
    t = toml_load(os.path.join(root, "Cargo.toml"))
    ws = t.get("workspace")
    dirs = []
    if isinstance(ws, dict):
        excl = {os.path.normpath(os.path.join(root, e)) for e in ws.get("exclude", [])}
        for pat in ws.get("members", []):
            for d in sorted(glob.glob(os.path.join(root, pat))):
                d = os.path.normpath(d)
                if d not in excl and os.path.exists(os.path.join(d, "Cargo.toml")):
                    dirs.append(d)
    if "package" in t and os.path.normpath(root) not in dirs:
        dirs.insert(0, os.path.normpath(root))
    return t, dirs


def module_path(cdir, f):
    rel = os.path.relpath(f, cdir).replace(os.sep, "/")
    if rel.startswith("tests/"):
        return None, "--test " + os.path.splitext(rel.split("/")[1])[0]
    if rel.startswith("src/bin/"):
        return None, "--bin " + os.path.splitext(rel.split("/")[2])[0]
    if rel.startswith("benches/") or rel.startswith("examples/"):
        return None, "--%s %s" % (rel.split("/")[0][:-1] if rel.startswith("examples") else "bench",
                                  os.path.splitext(rel.split("/")[1])[0])
    parts = rel[len("src/"):-3].split("/") if rel.startswith("src/") else []
    if parts and parts[-1] in ("mod", "lib", "main"):
        parts = parts[:-1]
    target = "--lib" if os.path.exists(os.path.join(cdir, "src/lib.rs")) else "--bins"
    return "::".join(parts), target


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("dir", nargs="?", default=".")
    ap.add_argument("--for", dest="for_file")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.dir)
    while not os.path.exists(os.path.join(root, "Cargo.toml")) and os.path.dirname(root) != root:
        root = os.path.dirname(root)
    if not os.path.exists(os.path.join(root, "Cargo.toml")):
        print("no Cargo.toml found at or above %s" % os.path.abspath(a.dir))
        return 0
    top, dirs = members(root)
    crates = [crate_info(root, d) for d in dirs]
    out = []
    if a.for_file:
        f = os.path.abspath(a.for_file)
        own = max((c for c in crates if f.startswith(os.path.join(root, c["dir"]) + os.sep)
                   or c["dir"] == "."), key=lambda c: len(c["dir"]), default=None)
        if not own:
            print("no crate owns %s" % a.for_file)
            return 0
        mod, target = module_path(os.path.join(root, own["dir"]), f)
        filt = (" " + mod) if mod else ""
        out.append("crate %s (%s), target %s, module %s" % (own["name"], own["dir"], target,
                                                             mod or "(target root)"))
        out.append("test: cargo test -p %s %s%s" % (own["name"], target, filt))
        out.append("check: cargo check -p %s --all-targets" % own["name"])
        print("\n".join(out))
        return 0
    tc = ""
    for n in ("rust-toolchain.toml", "rust-toolchain"):
        p = os.path.join(root, n)
        if os.path.exists(p):
            m = re.search(r'channel\s*=\s*"([^"]+)"', open(p).read()) or \
                re.match(r"\s*(\S+)", open(p).read())
            tc = m.group(1) if m else "?"
    ws = "workspace of %d crate(s)" % len(crates) if isinstance(top.get("workspace"), dict) \
        else "single crate"
    ed = ((top.get("workspace") or {}).get("package") or {}).get("edition", "") \
        if isinstance(top.get("workspace"), dict) else ""
    out.append("%s at %s%s%s" % (ws, root, "; toolchain " + tc if tc else "",
                                 "; edition " + ed if ed else ""))
    cfgs = sorted(glob.glob(os.path.join(root, ".cargo/*.toml"))) + \
        [p for p in [os.path.join(root, ".cargo/config")] if os.path.isfile(p)]
    vend = [os.path.relpath(p, root) for p in cfgs if "vendored-sources" in open(p).read()]
    if vend and not vend[0].endswith(("config.toml", "config")):
        vend[0] = "--config " + vend[0]
    lock = os.path.exists(os.path.join(root, "Cargo.lock"))
    out.append("Cargo.lock %s; %s" % ("present" if lock else "MISSING",
               "vendored sources configured (%s): use --offline" % vend[0] if vend
               else "no vendoring: use --offline if there is no network"))
    names = {c["name"] for c in crates}
    for c in crates[:14]:
        fl = ""
        if c["feats"]:
            dflt = c["feats"].get("default", [])
            others = [k for k in c["feats"] if k != "default"]
            fl = " features[default=%s; %s]" % (",".join(dflt) or "-", ",".join(others[:6]))
        deps = [d for d in c["local"] if d in names]
        out.append("- %s (%s) %s tests:%d%s%s%s" % (
            c["name"], c["dir"], "+".join(c["kinds"]) or "?", c["ntests"],
            " itests:" + ",".join(c["itests"][:5]) if c["itests"] else "",
            " deps:" + ",".join(deps[:5]) if deps else "", fl))
        for k, v in list(c["undeclared"].items())[:2]:
            out.append("    ! cfg(feature=\"%s\") at %s is not declared in [features]" % (k, v))
    if len(crates) > 14:
        out.append("(+%d more crates)" % (len(crates) - 14))
    first = crates[0]["name"] if crates else "CRATE"
    out.append("test one crate: cargo test -p %s   (add --all-features / --no-default-features"
               " to cover cfg code)" % first)
    out.append("owner of a file: crate_map.py --for path/to/file.rs")
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
