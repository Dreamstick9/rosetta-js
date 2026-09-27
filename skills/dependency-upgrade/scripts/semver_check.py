#!/usr/bin/env python3
"""Offline version/range semantics for npm, PEP 440 (pip), poetry, Cargo, Go and RubyGems.

usage:
  semver_check.py [--eco E] VERSION RANGE [RANGE...]
      → per RANGE: "yes|no  VERSION in RANGE  [eco]  = expanded comparators" (+ why, e.g. prerelease rule)
  semver_check.py [--eco E] --bump OLD NEW
      → major | minor | patch | prerelease | post | same | downgrade, with 0.x caret notes and
        whether ^OLD / ~OLD (or ~=OLD) would already accept NEW
  semver_check.py [--eco E] --latest-satisfying RANGE V1 V2 ... | @FILE | -
      → highest listed version inside RANGE. FILE/stdin may be registry JSON saved from web_fetch
        (PyPI /pypi/<pkg>/json, npm registry.npmjs.org/<pkg>, crates.io /api/v1/crates/<name>,
        Go proxy @v/list) or any text; yanked crates/PyPI releases are skipped.
  semver_check.py [--eco E] --sort V1 V2 ... | @FILE | -
      → versions in ascending order
  E = npm | pep440 | poetry | cargo | go | gem   (default: auto-detected from the syntax, always printed)

Semantics: npm ^ ~ x/* hyphen ranges, ||, comparators, 0.x caret rules, prereleases only when a
comparator on the same M.m.p has one. Cargo: bare = caret, comma = AND. PEP 440: == != <= >= < > ~= ===,
==1.2.*, local versions, dev < a < b < rc < final < post ordering, prereleases excluded unless the
specifier names one. Go: v-prefix, +incompatible, pseudo-versions; a bare version is an MVS minimum
within the same major. Exit 0 unless the arguments are wrong."""
import json
import re
import sys

ECOS = ("npm", "pep440", "poetry", "cargo", "go", "gem")

# ─────────────────────────── semver (npm / cargo / go) ───────────────────────────

ZERO = ("0",)  # the "-0" marker: lowest possible prerelease, used for exclusive upper bounds
_SV_FULL = re.compile(
    r"^\s*[=v]*\s*(\d+)\.(\d+)\.(\d+)(?:-?((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z.-]+))?\s*$"
)
_SV_PART = re.compile(
    r"^[=v]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?"
    r"(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$"
)


def parse_semver(s):
    """'v1.2.3-beta.1+build' → (1, 2, 3, ('beta', '1')); None when not a full semver."""
    m = _SV_FULL.match(s or "")
    if not m:
        return None
    pre = tuple(m.group(4).split(".")) if m.group(4) else ()
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), pre)


def _pre_key(ident):
    return (0, int(ident), "") if ident.isdigit() else (1, 0, ident)


def sv_key(v):
    return (v[0], v[1], v[2], 0 if v[3] else 1, tuple(_pre_key(x) for x in v[3]))


def sv_str(v):
    base = "%d.%d.%d" % (v[0], v[1], v[2])
    return base + ("-" + ".".join(v[3]) if v[3] else "")


def _partial(s):
    """'1.2' → (1, 2, None, ()); '*' → (None, None, None, ()). None if unparsable."""
    s = s.strip()
    if s in ("", "*", "x", "X"):
        return (None, None, None, ())
    m = _SV_PART.match(s)
    if not m:
        return None
    parts = []
    for g in m.group(1, 2, 3):
        if g is None or g in "xX*":
            break
        parts.append(int(g))
    while len(parts) < 3:
        parts.append(None)
    pre = tuple(m.group(4).split(".")) if (m.group(4) and parts[2] is not None) else ()
    return (parts[0], parts[1], parts[2], pre)


def _any():
    return [(">=", (0, 0, 0, ()))]


def _caret(M, m, p, pre):
    if M is None:
        return _any()
    if m is None:
        return [(">=", (M, 0, 0, ())), ("<", (M + 1, 0, 0, ZERO))]
    if p is None:
        up = (M + 1, 0, 0, ZERO) if M > 0 else (0, m + 1, 0, ZERO)
        return [(">=", (M, m, 0, ())), ("<", up)]
    if M > 0:
        up = (M + 1, 0, 0, ZERO)
    elif m > 0:
        up = (0, m + 1, 0, ZERO)
    else:
        up = (0, 0, p + 1, ZERO)
    return [(">=", (M, m, p, pre)), ("<", up)]


def _tilde(M, m, p, pre):
    if M is None:
        return _any()
    if m is None:
        return [(">=", (M, 0, 0, ())), ("<", (M + 1, 0, 0, ZERO))]
    return [(">=", (M, m, p or 0, pre)), ("<", (M, m + 1, 0, ZERO))]


def _xrange(M, m, p, pre):
    if M is None:
        return _any()
    if m is None:
        return [(">=", (M, 0, 0, ())), ("<", (M + 1, 0, 0, ZERO))]
    if p is None:
        return [(">=", (M, m, 0, ())), ("<", (M, m + 1, 0, ZERO))]
    return [("=", (M, m, p, pre))]


def _cmp_partial(op, M, m, p, pre):
    if M is None:
        return _any() if op in (">=", "<=") else [("<", (0, 0, 0, ZERO))]
    if p is not None:
        return [(op, (M, m, p, pre))]
    if op == ">":
        return [(">=", (M + 1, 0, 0, ()) if m is None else (M, m + 1, 0, ()))]
    if op == ">=":
        return [(">=", (M, m or 0, 0, ()))]
    if op == "<":
        return [("<", (M, m or 0, 0, ZERO))]
    if op == "<=":
        return [("<", (M + 1, 0, 0, ZERO) if m is None else (M, m + 1, 0, ZERO))]
    return _xrange(M, m, p, pre)


_OPS = re.compile(r"^(<=|>=|<|>|=|\^|~>|~)?(.*)$")


def _token(tok, bare_caret):
    m = _OPS.match(tok.strip())
    op, ver = m.group(1) or "", m.group(2)
    pv = _partial(ver)
    if pv is None:
        raise ValueError("bad version %r" % tok)
    wild = bool(re.search(r"(^|\.)[xX*]", ver))
    if op == "^" or (op == "" and bare_caret and not wild):
        return _caret(*pv)
    if op in ("~", "~>"):
        return _tilde(*pv)
    if op in ("", "="):
        return _xrange(*pv)
    return _cmp_partial(op, *pv)


def parse_sv_range(rng, eco="npm"):
    """npm/cargo range → list of alternatives (OR), each a list of (op, semver) (AND)."""
    rng = (rng or "").strip()
    if rng.startswith("workspace:"):
        rng = rng[len("workspace:"):]
        rng = "*" if rng in ("*", "^", "~") else rng
    if rng.startswith("npm:") and "@" in rng[4:]:
        rng = rng.rsplit("@", 1)[1]
    if rng in ("", "*", "latest", "x", "X"):
        return [_any()]
    alts = []
    for part in rng.split("||"):
        part = re.sub(r"(<=|>=|<|>|=|\^|~>|~)\s+", r"\1", part.strip())
        hy = re.match(r"^(\S+)\s+-\s+(\S+)$", part)
        if hy and eco != "cargo":
            a, b = _partial(hy.group(1)), _partial(hy.group(2))
            if a is None or b is None:
                raise ValueError("bad hyphen range %r" % part)
            comps = [] if a[0] is None else [(">=", (a[0], a[1] or 0, a[2] or 0, a[3]))]
            if b[0] is not None:
                if b[1] is None:
                    comps.append(("<", (b[0] + 1, 0, 0, ZERO)))
                elif b[2] is None:
                    comps.append(("<", (b[0], b[1] + 1, 0, ZERO)))
                else:
                    comps.append(("<=", b))
            alts.append(comps or _any())
            continue
        toks = [t for t in re.split(r"[\s,]+", part) if t]
        comps = []
        for t in toks:
            comps.extend(_token(t, bare_caret=(eco == "cargo")))
        alts.append(comps or _any())
    return alts


def _cmp(a, op, b):
    ka, kb = sv_key(a), sv_key(b)
    return {"<": ka < kb, "<=": ka <= kb, ">": ka > kb, ">=": ka >= kb, "=": ka == kb}[op]


def sv_satisfies(v, alts):
    """Returns (ok, reason)."""
    reason = ""
    for comps in alts:
        if not all(_cmp(v, op, c) for op, c in comps):
            continue
        if v[3]:
            same = [c for _, c in comps if c[3] and c[3] != ZERO and c[:3] == v[:3]]
            if not same:
                reason = "prerelease %s only matches a range naming a %d.%d.%d prerelease" % ((sv_str(v),) + v[:3])
                continue
        return True, ""
    return False, reason


def render_sv(alts):
    out = []
    for comps in alts:
        s = " ".join("%s%s" % (op if op != "=" else "=", sv_str((c[0], c[1], c[2], () if c[3] == ZERO else c[3])))
                     for op, c in comps)
        out.append(s if s != ">=0.0.0" else "*")
    return " || ".join(out)


# ─────────────────────────── Go ───────────────────────────

def parse_go(s):
    s = (s or "").strip()
    if not s.startswith("v"):
        s = "v" + s
    return parse_semver(s[1:].split("+", 1)[0])


def go_satisfies(v, rng):
    rng = rng.strip()
    base = parse_go(rng)
    if base is not None:  # MVS: a require is a minimum within the same major version
        ok = sv_key(v) >= sv_key(base) and v[0] == base[0]
        return ok, ">=%s <%d.0.0 (MVS minimum, same major)" % (sv_str(base), base[0] + 1), \
            "" if ok else ("different major: needs a /v%d module path" % v[0] if v[0] != base[0] else "below the minimum")
    alts = parse_sv_range(rng.replace("v", ""), "npm")
    ok, why = sv_satisfies(v, alts)
    return ok, render_sv(alts), why


# ─────────────────────────── PEP 440 ───────────────────────────

_PEP = re.compile(
    r"""^\s*v?(?:(?P<epoch>\d+)!)?(?P<release>\d+(?:\.\d+)*)
    (?P<pre>[-_.]?(?P<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?P<pre_n>\d+)?)?
    (?P<post>(?:-(?P<post_n1>\d+))|(?:[-_.]?(?P<post_l>post|rev|r)[-_.]?(?P<post_n2>\d+)?))?
    (?P<dev>[-_.]?(?P<dev_l>dev)[-_.]?(?P<dev_n>\d+)?)?
    (?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$""",
    re.X | re.I,
)
_PRE_NORM = {"alpha": "a", "a": "a", "beta": "b", "b": "b", "c": "rc", "rc": "rc", "pre": "rc", "preview": "rc"}
_PRE_ORD = {"a": 0, "b": 1, "rc": 2}


class PV(object):
    __slots__ = ("epoch", "release", "pre", "post", "dev", "local", "raw")

    def __init__(self, epoch, release, pre, post, dev, local, raw):
        self.epoch, self.release, self.pre, self.post, self.dev, self.local, self.raw = \
            epoch, release, pre, post, dev, local, raw

    @property
    def is_pre(self):
        return self.pre is not None or self.dev is not None

    def key(self, with_local=True):
        rel = list(self.release)
        while len(rel) > 1 and rel[-1] == 0:
            rel.pop()
        if self.pre is None and self.post is None and self.dev is not None:
            pre = (-1,)
        elif self.pre is None:
            pre = (3,)
        else:
            pre = (1, _PRE_ORD[self.pre[0]], self.pre[1])
        post = (-1,) if self.post is None else (1, self.post)
        dev = (2,) if self.dev is None else (1, self.dev)
        loc = ()
        if with_local and self.local is not None:
            loc = tuple((1, int(x), "") if x.isdigit() else (0, 0, x) for x in self.local)
        return (self.epoch, tuple(rel), pre, post, dev, loc)

    def public(self):
        return PV(self.epoch, self.release, self.pre, self.post, self.dev, None, self.raw)

    def __str__(self):
        s = ("%d!" % self.epoch if self.epoch else "") + ".".join(map(str, self.release))
        if self.pre:
            s += "%s%d" % self.pre
        if self.post is not None:
            s += ".post%d" % self.post
        if self.dev is not None:
            s += ".dev%d" % self.dev
        if self.local:
            s += "+" + ".".join(self.local)
        return s


def parse_pep(s):
    m = _PEP.match(s or "")
    if not m:
        return None
    pre = None
    if m.group("pre_l"):
        pre = (_PRE_NORM[m.group("pre_l").lower()], int(m.group("pre_n") or 0))
    post = None
    if m.group("post"):
        post = int(m.group("post_n1") or m.group("post_n2") or 0)
    dev = int(m.group("dev_n") or 0) if m.group("dev") else None
    local = tuple(re.split(r"[-_.]", m.group("local").lower())) if m.group("local") else None
    rel = tuple(int(x) for x in m.group("release").split("."))
    return PV(int(m.group("epoch") or 0), rel, pre, post, dev, local, s.strip())


_PEP_SPEC = re.compile(r"^\s*(~=|===|==|!=|<=|>=|<|>)?\s*(.+?)\s*$")


def parse_pep_specs(rng):
    """'>=1.0, <2 ; python_version<"3.8"' → [(op, text)]. Raises ValueError."""
    rng = (rng or "").split(";", 1)[0].strip()
    if rng.startswith("(") and rng.endswith(")"):
        rng = rng[1:-1]
    out = []
    for part in [p for p in rng.split(",") if p.strip()]:
        m = _PEP_SPEC.match(part)
        if not m:
            raise ValueError("bad specifier %r" % part)
        op, ver = m.group(1) or "==", m.group(2)
        if op != "===":
            base = ver[:-2] if (ver.endswith(".*") and op in ("==", "!=")) else ver
            if parse_pep(base) is None:
                raise ValueError("bad version %r in %r" % (ver, part.strip()))
        out.append((op, ver))
    return out


def _pep_eq(v, ver):
    if ver.endswith(".*"):
        spec = parse_pep(ver[:-2])
        if spec.epoch != v.epoch:
            return False
        n = len(spec.release)
        rel = list(v.release) + [0] * max(0, n - len(v.release))
        return tuple(rel[:n]) == spec.release
    spec = parse_pep(ver)
    if spec.local is not None:
        return v.key() == spec.key()
    return v.key(False) == spec.key(False)


def _pep_match(v, op, ver):
    if op == "===":
        return v.raw.lower() == ver.lower()
    if op == "==":
        return _pep_eq(v, ver)
    if op == "!=":
        return not _pep_eq(v, ver)
    spec = parse_pep(ver)
    kv, ks = v.key(False), spec.key(False)
    if op == "~=":
        if len(spec.release) < 2:
            return False
        prefix = ".".join(map(str, spec.release[:-1])) + ".*"
        if spec.epoch:
            prefix = "%d!%s" % (spec.epoch, prefix)
        return kv >= ks and _pep_eq(v, prefix)
    if op == "<=":
        return kv <= ks
    if op == ">=":
        return kv >= ks
    same_base = (v.epoch, v.key()[1]) == (spec.epoch, spec.key()[1])
    if op == "<":
        return kv < ks and not (not spec.is_pre and v.is_pre and same_base)
    if op == ">":
        if not kv > ks:
            return False
        if spec.post is None and v.post is not None and same_base:
            return False
        return not (v.local is not None and same_base)
    return False


def _spec_names_pre(op, ver):
    if op not in ("==", ">=", "<=", "~=", "===", ">", "<"):
        return False
    p = parse_pep(ver[:-2] if ver.endswith(".*") else ver)
    return bool(p and p.is_pre)


def pep_satisfies(v, specs, prereleases=None):
    allow = prereleases if prereleases is not None else any(_spec_names_pre(o, x) for o, x in specs)
    for op, ver in specs:
        if not _pep_match(v, op, ver):
            return False, ""
    if v.is_pre and not allow:
        return False, "prerelease %s excluded (no specifier names a prerelease; pip needs --pre)" % v
    return True, ""


# ─────────────────────────── poetry / gem → PEP 440 ───────────────────────────

def _bump_rel(rel, idx):
    rel = list(rel[: idx + 1])
    rel[idx] += 1
    return ".".join(map(str, rel))


def poetry_to_pep(rng):
    """poetry constraint → list of alternatives, each a PEP 440 specifier list."""
    alts = []
    for part in (rng or "*").split("||"):
        part = re.sub(r"(<=|>=|<|>|==|!=|~=|=|\^|~)\s+", r"\1", part.strip())
        specs = []
        for t in [t for t in re.split(r"[\s,]+", part) if t]:
            if t in ("*", "x"):
                continue
            if t[0] in "^~" and not t.startswith("~="):
                p = parse_pep(t[1:])
                if p is None:
                    raise ValueError("bad version %r" % t)
                rel = p.release
                if t[0] == "^":
                    idx = next((i for i, x in enumerate(rel) if x != 0), len(rel) - 1)
                else:
                    idx = 1 if len(rel) >= 2 else 0
                    idx = min(idx, len(rel) - 1)
                specs += [(">=", t[1:]), ("<", _bump_rel(rel + (0,) * 3, idx))]
            elif re.match(r"^(~=|===|==|!=|<=|>=|<|>)", t):
                specs += parse_pep_specs(t)
            else:
                specs.append(("==", t.lstrip("=")))
        alts.append(specs)
    return alts


def gem_to_pep(rng):
    specs = []
    for t in [t.strip() for t in re.split(r",", rng or "") if t.strip()]:
        m = re.match(r"^(~>|>=|<=|!=|=|>|<)?\s*(\S+)$", t)
        if not m:
            raise ValueError("bad gem requirement %r" % t)
        op, ver = m.group(1) or "=", m.group(2)
        if op == "~>":
            p = parse_pep(ver)
            if p is None:
                raise ValueError("bad version %r" % ver)
            if len(p.release) == 1:
                specs += [(">=", ver), ("<", str(p.release[0] + 1))]
            else:
                specs.append(("~=", ver))
        else:
            specs.append(("==" if op == "=" else op, ver))
    return specs


# ─────────────────────────── dispatch ───────────────────────────

def detect_eco(ranges, versions):
    text = " ".join(ranges)
    allv = list(ranges) + list(versions)
    if "~>" in text:
        return "gem"
    if re.search(r"~=|===|==|!=", text):
        return "pep440"
    if any(re.match(r"^\s*v\d", x) for x in allv) and not re.search(r"[\^~|]", text):
        return "go"
    pep_ver = re.compile(r"\d(?:a|b|c|rc|alpha|beta|pre|post|dev)\d*(?:$|[.+])|\d!\d|\.post\d|\.dev\d", re.I)
    if any(pep_ver.search(x) and "-" not in x for x in allv):
        return "pep440"
    if "||" in text or re.search(r"\s-\s", text) or re.search(r"(^|[\s.^~])[xX](\.|$|\s)", text):
        return "npm"
    if versions and not any(parse_semver(x.lstrip("v")) for x in versions) \
            and any(parse_pep(x) for x in versions):
        return "pep440"
    if "," in text:
        toks = [t.strip() for t in text.split(",") if t.strip()]
        if any(re.match(r"^[\^~\d]", t) for t in toks) or any("-" in v for v in versions):
            return "cargo"
        return "pep440"
    return "npm"


def parse_version(s, eco):
    if eco in ("pep440", "poetry", "gem"):
        return parse_pep(s)
    if eco == "go":
        return parse_go(s)
    v = parse_semver(s)
    return v


def version_key(v, eco):
    return v.key() if eco in ("pep440", "poetry", "gem") else sv_key(v)


def vstr(v, eco):
    return str(v) if eco in ("pep440", "poetry", "gem") else sv_str(v)


def satisfies(version, rng, eco, prereleases=None):
    """→ (ok: bool|None, expansion, note). ok None = could not parse."""
    v = parse_version(version, eco)
    if v is None:
        return None, "", "cannot parse version %r as %s" % (version, eco)
    try:
        if eco in ("npm", "cargo"):
            alts = parse_sv_range(rng, eco)
            ok, why = sv_satisfies(v, alts)
            return ok, render_sv(alts), why
        if eco == "go":
            return go_satisfies(v, rng)
        if eco == "pep440":
            specs = parse_pep_specs(rng)
            ok, why = pep_satisfies(v, specs, prereleases)
            return ok, ",".join(o + x for o, x in specs) or "*", why
        if eco in ("poetry", "gem"):
            alts = poetry_to_pep(rng) if eco == "poetry" else [gem_to_pep(rng)]
            why = ""
            for specs in alts:
                ok, w = pep_satisfies(v, specs, prereleases)
                if ok:
                    break
                why = why or w
            return ok, " || ".join(",".join(o + x for o, x in s) or "*" for s in alts), ("" if ok else why)
    except ValueError as e:
        return None, "", str(e)
    return None, "", "unknown ecosystem %s" % eco


def bump_kind(old, new, eco):
    """→ (kind, note). kind: major/minor/patch/prerelease/post/local/same/downgrade/unknown."""
    a, b = parse_version(old, eco), parse_version(new, eco)
    if a is None or b is None:
        return "unknown", "cannot parse %r or %r as %s" % (old, new, eco)
    ka, kb = version_key(a, eco), version_key(b, eco)
    if kb == ka:
        return "same", ""
    down = kb < ka
    note = ""
    if eco in ("pep440", "poetry", "gem"):
        ra, rb = list(a.release) + [0] * 3, list(b.release) + [0] * 3
        if a.epoch != b.epoch:
            kind = "major"
            note = "epoch changed"
        else:
            idx = next((i for i in range(max(len(ra), len(rb))) if ra[i:i + 1] != rb[i:i + 1]), None)
            if idx is None:
                if a.pre != b.pre or a.dev != b.dev:
                    kind = "prerelease"
                elif a.post != b.post:
                    kind = "post"
                else:
                    kind = "local"
            else:
                kind = ("major", "minor")[idx] if idx < 2 else "patch"
                if idx == 1 and ra[0] == 0:
                    note = "0.x: a minor bump may break (poetry ^0.%d stops before 0.%d)" % (ra[1], ra[1] + 1)
    else:
        if a[0] != b[0]:
            kind = "major"
        elif a[1] != b[1]:
            kind = "minor"
            if a[0] == 0:
                note = "0.x: minor bump is BREAKING under caret (^0.%d.x excludes 0.%d)" % (a[1], b[1])
        elif a[2] != b[2]:
            kind = "patch"
            if a[0] == 0 and a[1] == 0:
                note = "0.0.x: every patch bump is BREAKING under caret"
        else:
            kind = "prerelease"
        if eco == "go" and a[0] != b[0] and max(a[0], b[0]) >= 2:
            note = "Go major >=2 changes the module path (/v%d) unless +incompatible" % max(a[0], b[0])
    if down:
        return "downgrade", ("from a %s-level difference" % kind) + ("; " + note if note else "")
    if (b.is_pre if eco in ("pep440", "poetry", "gem") else bool(b[3])):
        note = (note + "; " if note else "") + "target is a prerelease"
    return kind, note


def extract_versions(args):
    """Candidates from argv, @FILE or - (stdin); understands registry JSON."""
    texts, out = [], []
    for a in args:
        if a == "-":
            texts.append(sys.stdin.read())
        elif a.startswith("@"):
            try:
                with open(a[1:], encoding="utf-8", errors="replace") as f:
                    texts.append(f.read())
            except OSError as e:
                raise SystemExit("semver_check: %s" % e)
        else:
            out.extend(x for x in re.split(r"[\s,]+", a) if x)
    skipped = 0
    for t in texts:
        data = None
        try:
            data = json.loads(t)
        except ValueError:
            pass
        if isinstance(data, dict) and isinstance(data.get("releases"), dict):  # PyPI
            for ver, files in data["releases"].items():
                if files and all(isinstance(f, dict) and f.get("yanked") for f in files):
                    skipped += 1
                    continue
                out.append(ver)
        elif isinstance(data, dict) and isinstance(data.get("versions"), dict):  # npm
            out.extend(data["versions"].keys())
        elif isinstance(data, dict) and isinstance(data.get("versions"), list):  # crates.io
            for v in data["versions"]:
                if isinstance(v, dict) and v.get("num"):
                    if v.get("yanked"):
                        skipped += 1
                    else:
                        out.append(v["num"])
        else:
            out.extend(re.findall(r"(?<![\w.])v?\d+(?:\.\d+)+(?:[-+._]?[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", t))
    seen, uniq = set(), []
    for v in out:
        if v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq, skipped


def usage(code=0):
    print(__doc__)
    sys.exit(code)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        usage(0)
    eco = None
    if "--eco" in argv:
        i = argv.index("--eco")
        if i + 1 >= len(argv) or argv[i + 1] not in ECOS:
            print("semver_check: --eco needs one of %s" % ", ".join(ECOS), file=sys.stderr)
            return 2
        eco = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    auto = eco is None
    mode = argv[0] if argv and argv[0].startswith("--") else None

    if mode == "--bump":
        if len(argv) != 3:
            usage(2)
        old, new = argv[1], argv[2]
        eco = eco or detect_eco([], [old, new])
        kind, note = bump_kind(old, new, eco)
        print("%s → %s: %s  [%s%s]" % (old, new, kind, eco, " auto" if auto else "") + ("  (%s)" % note if note else ""))
        if kind not in ("unknown", "same"):
            checks = [("^" + old, "npm" if eco != "cargo" else "cargo"), ("~" + old, "npm")] \
                if eco in ("npm", "cargo", "go") else [("~=" + old, "pep440"), ("==" + old, "pep440")]
            if eco == "go":
                checks = [(old, "go")]
            for rng, e in checks:
                ok, exp, _ = satisfies(new, rng.lstrip("v") if e != "go" else rng, e)
                if ok is not None:
                    print("  %-3s %s already accepts %s  (= %s)" % ("yes" if ok else "no", rng, new, exp))
        return 0

    if mode in ("--latest-satisfying", "--sort"):
        rest = argv[1:]
        rng = None
        if mode == "--latest-satisfying":
            if not rest:
                usage(2)
            rng, rest = rest[0], rest[1:]
        cands, skipped = extract_versions(rest)
        if not cands:
            print("semver_check: no candidate versions given", file=sys.stderr)
            return 2
        eco = eco or detect_eco([rng] if rng else [], cands[:50])
        parsed, bad = [], []
        for c in cands:
            v = parse_version(c, eco)
            (parsed if v is not None else bad).append((c, v))
        parsed.sort(key=lambda cv: (version_key(cv[1], eco), cv[0]))
        if mode == "--sort":
            lines = [c for c, _ in parsed]
            print("sorted %d versions ascending [%s%s]%s" % (len(lines), eco, " auto" if auto else "",
                                                            ("; unparsable: " + ", ".join(c for c, _ in bad[:8])) if bad else ""))
            if len(lines) > 38:
                print("\n".join(lines[:19]))
                print("... (+%d more) ..." % (len(lines) - 37))
                print("\n".join(lines[-18:]))
            else:
                print("\n".join(lines))
            return 0
        sat = [(c, v) for c, v in parsed if satisfies(c, rng, eco)[0]]
        note = ""
        if not sat and eco in ("pep440", "poetry"):
            sat = [(c, v) for c, v in parsed if satisfies(c, rng, eco, prereleases=True)[0]]
            note = " (only prereleases match; pip picks them when no final release fits)" if sat else ""
        _, exp, err = satisfies(parsed[-1][0], rng, eco) if parsed else (None, "", "")
        if err and not exp:
            print("semver_check: %s" % err)
            return 0
        newest = parsed[-1][0] if parsed else "?"
        if sat:
            print("latest satisfying %s: %s  [%s%s] = %s%s" % (rng, sat[-1][0], eco, " auto" if auto else "", exp, note))
        else:
            print("latest satisfying %s: NONE  [%s%s] = %s" % (rng, eco, " auto" if auto else "", exp))
        print("  %d of %d candidates satisfy; newest overall %s%s%s" % (
            len(sat), len(parsed), newest, ("; %d yanked skipped" % skipped) if skipped else "",
            ("; %d unparsable" % len(bad)) if bad else ""))
        if sat:
            print("  top matches: " + ", ".join(c for c, _ in reversed(sat[-8:])))
        newer = [c for c, v in parsed if sat and version_key(v, eco) > version_key(sat[-1][1], eco)]
        if newer:
            print("  newer, outside range: " + ", ".join(newer[-8:][::-1]) + (" (+%d more)" % (len(newer) - 8) if len(newer) > 8 else ""))
        return 0

    if mode:
        print("semver_check: unknown option %s" % mode, file=sys.stderr)
        return 2
    version, ranges = argv[0], argv[1:]
    eco = eco or detect_eco(ranges, [version])
    v = parse_version(version, eco)
    if v is None:
        print("%s: not a valid %s version" % (version, eco))
        return 0
    if not ranges:
        print("%s → %s  [%s%s] prerelease=%s" % (version, vstr(v, eco), eco, " auto" if auto else "",
                                                 "yes" if (v.is_pre if eco in ("pep440", "poetry", "gem") else bool(v[3])) else "no"))
        return 0
    for rng in ranges[:38]:
        ok, exp, why = satisfies(version, rng, eco)
        tag = "yes" if ok else ("ERR" if ok is None else "no")
        line = "%-3s %s in %s  [%s%s]" % (tag, version, rng, eco, " auto" if auto else "")
        if exp:
            line += " = " + exp
        if why:
            line += "  (%s)" % why
        print(line)
    if auto and eco == "npm" and any(_partial(r) is not None and _partial(r)[2] is not None and r.strip()[:1].isdigit()
                                     for r in ranges):
        print("note: bare versions are exact in npm; Cargo treats them as ^ (use --eco cargo)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
