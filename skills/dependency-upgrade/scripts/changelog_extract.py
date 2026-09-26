#!/usr/bin/env python3
"""Pull only the upgrade-relevant lines out of a changelog / release notes between two versions.

usage: changelog_extract.py FILE|- [--from V1] [--to V2] [--grep WORD]... [--all]
  FILE: CHANGELOG.md, HISTORY.rst, NEWS, CHANGES.txt, or text/markdown/HTML saved from web_fetch of
        GitHub releases or a docs "what's new" page; "-" reads stdin.
  Selects sections with V1 < version <= V2 (V2 defaults to the newest; V1 defaults to everything)
  and prints, tagged with each line's version and line number:
    breaking / backwards-incompatible / removed / deprecated / renamed / no longer / dropped support /
    migration / security / CVE / "now requires" / "instead" / "default changed" lines, every line under
    a Breaking / Removed / Deprecated / Security / Migration / Upgrading sub-heading, and --grep WORD
    lines (e.g. an API name from api_usage.py; case-insensitive regex, repeatable).
    --all  also prints the lines under "Changed" sub-headings when they fit.
  Version headings recognised: markdown #..###### with a version, "## [1.2.3] - 2024-01-01",
  "v1.2.3 (2024-01-01)", "Version 1.2.3", "Release 1.2.3", "1.2.3 / 2024-01-01", rst titles with
  ===/---/~~~ underlines, and HTML <h1>-<h4>. An "Unreleased" section is skipped.
Output ≤40 lines. Exit 0 unless usage is wrong."""
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import semver_check as sv  # noqa: E402

VER = r"v?(\d+\.\d+(?:\.\d+){0,2}(?:[-.]?(?:alpha|beta|rc|a|b|c|pre|dev|post)\.?\d*)?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)"
VER_RE = re.compile(r"(?<![\w.])" + VER + r"(?![\w])")
IMPORTANT = re.compile(
    r"breaking|backwards?[- ]?incompatib|\bincompatib|\bremov(e|ed|es|al|ing)\b|deprecat|\brenam(e|ed|es|ing)\b|"
    r"no longer|drop(ped|s|ping)?\b.{0,30}\bsupport|\bdropped\b|migrat|upgrade guide|upgrading|security|"
    r"\bcve-\d|vulnerab|\bghsa-|must now|now requires?|minimum (supported )?(version|python|node|rust|go)|"
    r"requires? (python|node|rust|go) ?[\d>]|replaced (by|with)|instead of|use \S+ instead|changed? the default|"
    r"default (is|was|changed|now)|behaviou?r change|\bnow raises?\b|\bnow returns?\b|\bnot supported\b|"
    r"\bbc break|⚠|\w+!:|^\s*[-*]?\s*\*\*breaking",
    re.I,
)
HOT_HEADING = re.compile(r"break|incompat|remov|deprecat|security|migrat|upgrad|backward|notable|attention|"
                         r"api change", re.I)
WARM_HEADING = re.compile(r"^\W*(changed?|changes|behaviou?r)\W*$", re.I)
RST_UNDER = re.compile(r"^([=\-~^*+#`'\"])\1{2,}\s*$")


def strip_html(text):
    if not re.search(r"<(h[1-6]|li|p|div)\b", text, re.I):
        return text
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", text)
    text = re.sub(r"(?i)<h([1-6])[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", text)
    text = re.sub(r"(?i)</h[1-6]>|<br\s*/?>|</p>|</div>", "\n", text)
    text = re.sub(r"(?i)<li[^>]*>", "\n- ", text)
    text = re.sub(r"<[^>]+>", "", text)
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&"), ("&nbsp;", " ")):
        text = text.replace(a, b)
    return text


def vkey(s):
    p = sv.parse_pep(s)
    if p is not None:
        return (1, p.key())
    q = sv.parse_semver(s.lstrip("v"))
    if q is not None:
        rel = (q[0], q[1], q[2])
        return (1, (0, rel, (0,) if q[3] else (3,), (-1,), (2,), ()))
    nums = tuple(int(x) for x in re.findall(r"\d+", s)[:4])
    return (0, nums)


def heading_version(lines, i):
    """→ (version, level, style) if line i is a version heading, else None."""
    line = lines[i].rstrip()
    s = line.strip()
    if not s or len(s) > 120:
        return None
    m = re.match(r"^(#{1,6})\s+(.*)$", s)
    if m:
        body = m.group(2)
        if re.match(r"^\[?unreleased\]?", body, re.I):
            return ("UNRELEASED", len(m.group(1)), "md")
        v = VER_RE.search(body)
        if v and v.start() < 40:
            return (v.group(1), len(m.group(1)), "md")
        return None
    if i + 1 < len(lines) and RST_UNDER.match(lines[i + 1].strip()) and len(lines[i + 1].strip()) >= min(len(s), 3):
        if re.match(r"^\[?unreleased\]?", s, re.I):
            return ("UNRELEASED", "rst" + lines[i + 1].strip()[0], "rst")
        v = VER_RE.search(s)
        if v and v.start() < 40:
            return (v.group(1), "rst" + lines[i + 1].strip()[0], "rst")
        return None
    if line[:1].isspace() or s.startswith(("-", "*", "+")):
        return None
    m = re.match(r"^(?:\[?(?:version|release|v(?=\d))\s*)?\[?" + VER + r"\]?\s*(?:[-/:(–—]\s*.*|\(.*\)|\s+\d{4}-\d\d-\d\d.*)?$", s, re.I)
    if m and (re.match(r"^(version|release)\b", s, re.I) or re.search(r"\d{4}-\d\d-\d\d|\(|^v\d|^\[", s)
              or re.match(r"^" + VER + r"\s*$", s)):
        return (m.group(1), "plain", "plain")
    return None


def sections(lines):
    heads = []
    for i in range(len(lines)):
        h = heading_version(lines, i)
        if h:
            heads.append((i, h))
    if not heads:
        return [], None
    levels = {}
    for _, (v, lvl, _) in heads:
        if v != "UNRELEASED":
            levels[lvl] = levels.get(lvl, 0) + 1
    if not levels:
        return [], None
    # the version-heading level is the most common one; ties go to the shallowest
    best = sorted(levels.items(), key=lambda kv: (-kv[1], str(kv[0])))[0][0]
    heads = [(i, h) for i, h in heads if h[1] == best]
    secs = []
    for k, (i, h) in enumerate(heads):
        end = heads[k + 1][0] if k + 1 < len(heads) else len(lines)
        secs.append((h[0], i, end))
    return secs, best


def is_subheading(lines, j):
    s = lines[j].strip()
    if re.match(r"^#{1,6}\s+\S", s):
        return re.sub(r"^#+\s*", "", s)
    if j + 1 < len(lines) and RST_UNDER.match(lines[j + 1].strip()) and s and not RST_UNDER.match(s):
        return s
    m = re.match(r"^\*\*([^*]{2,60})\*\*:?\s*$|^__([^_]{2,60})__:?\s*$|^([A-Z][A-Za-z /&-]{2,40}):\s*$", s)
    if m:
        return m.group(1) or m.group(2) or m.group(3)
    return None


def main(argv):
    if not argv or "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    src, v_from, v_to, greps, show_all = None, None, None, [], False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--from", "--to", "--grep"):
            if i + 1 >= len(argv):
                print("changelog_extract: %s needs a value" % a, file=sys.stderr)
                return 2
            val = argv[i + 1]
            if a == "--from":
                v_from = val
            elif a == "--to":
                v_to = val
            else:
                greps.append(val)
            i += 2
            continue
        if a == "--all":
            show_all = True
        elif a.startswith("-") and a != "-":
            print("changelog_extract: unknown option %s" % a, file=sys.stderr)
            return 2
        elif src is None:
            src = a
        else:
            print("changelog_extract: one FILE only", file=sys.stderr)
            return 2
        i += 1
    if src is None:
        print("changelog_extract: FILE or - required", file=sys.stderr)
        return 2
    if src == "-":
        text = sys.stdin.read()
    else:
        try:
            with open(src, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            print("changelog_extract: %s" % e, file=sys.stderr)
            return 2
    try:
        grep_re = re.compile("|".join("(?:%s)" % g for g in greps), re.I) if greps else None
    except re.error:
        grep_re = re.compile("|".join(re.escape(g) for g in greps), re.I)
    lines = strip_html(text).replace("\r\n", "\n").split("\n")
    secs, level = sections(lines)
    name = "stdin" if src == "-" else os.path.basename(src)
    if not secs:
        print("changelog_extract: no version headings found in %s (%d lines)" % (name, len(lines)))
        hits = [(j + 1, l.strip()) for j, l in enumerate(lines)
                if l.strip() and (IMPORTANT.search(l) or (grep_re and grep_re.search(l)))]
        for ln, l in hits[:38]:
            print("L%d: %s" % (ln, l[:200]))
        if len(hits) > 38:
            print("(+%d more)" % (len(hits) - 38))
        return 0
    real = [s for s in secs if s[0] != "UNRELEASED"]
    newest = max(real, key=lambda s: vkey(s[0]))[0] if real else "?"
    kf = vkey(v_from.lstrip("v")) if v_from else None
    kt = vkey(v_to.lstrip("v")) if v_to else None
    chosen = [s for s in real if (kf is None or vkey(s[0]) > kf) and (kt is None or vkey(s[0]) <= kt)]
    chosen.sort(key=lambda s: vkey(s[0]), reverse=True)
    skipped_unrel = any(s[0] == "UNRELEASED" for s in secs)
    rng = "(%s, %s]" % (v_from or "-inf", v_to or "newest")
    hdr = "changelog_extract %s: %d of %d sections in %s: %s" % (
        name, len(chosen), len(real), rng,
        ", ".join(s[0] for s in chosen[:12]) + (" (+%d)" % (len(chosen) - 12) if len(chosen) > 12 else "") if chosen else "none")
    hdr += "; newest in file %s" % newest + ("; Unreleased skipped" if skipped_unrel else "")
    print(hdr)
    if not chosen:
        print("available: " + ", ".join(s[0] for s in sorted(real, key=lambda s: vkey(s[0]), reverse=True)[:20]))
        return 0
    hot, warm = [], []  # (version order, line no, text, is_heading)
    for order, (ver, start, end) in enumerate(chosen):
        cur_mode = None
        for j in range(start + 1, end):
            raw = lines[j]
            s = raw.strip()
            if not s or RST_UNDER.match(s):
                continue
            sub = is_subheading(lines, j)
            if sub is not None:
                cur_mode = "hot" if HOT_HEADING.search(sub) else ("warm" if WARM_HEADING.match(sub) else None)
                if cur_mode == "hot" or (grep_re and grep_re.search(s)):
                    hot.append((order, j + 1, ver, s, True))
                elif cur_mode == "warm":
                    warm.append((order, j + 1, ver, s, True))
                continue
            if cur_mode == "hot" or IMPORTANT.search(s) or (grep_re and grep_re.search(s)):
                hot.append((order, j + 1, ver, raw.rstrip(), False))
            elif cur_mode == "warm":
                warm.append((order, j + 1, ver, raw.rstrip(), False))
    budget = 38
    picked = list(hot)
    if show_all or len(hot) + len(warm) <= budget:
        picked += warm
    elif warm:
        print("(%d lines under 'Changed' headings omitted; --all to include)" % len(warm))
        budget -= 1
    picked.sort(key=lambda x: (x[0], x[1]))
    if not picked:
        print("no breaking/removed/deprecated/security lines in the selected sections — read the sections directly:")
        for ver, start, end in chosen[:10]:
            print("  %s: lines %d-%d" % (ver, start + 1, end))
        return 0
    shown = 0
    for order, ln, ver, s, is_head in picked:
        if shown >= budget:
            break
        s = s if len(s) <= 220 else s[:217] + "..."
        print("%s L%d: %s" % (ver, ln, s))
        shown += 1
    if len(picked) > shown:
        print("(+%d more; narrow with --to or --grep)" % (len(picked) - shown))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
