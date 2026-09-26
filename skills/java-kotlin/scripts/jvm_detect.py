#!/usr/bin/env python3
"""Map a Maven or Gradle project in one call: build tool and wrapper, modules,
Java/Kotlin versions, test frameworks, test class counts per module, JDK on
PATH, and exact offline build/test commands. With --for FILE: the module, the
matching test class and the command that runs it.

usage:
  jvm_detect.py [DIR]              map the project (default: .)
  jvm_detect.py [DIR] --for FILE   module + test class + command for a source or test file
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

SKIP = {".git", "target", "build", ".gradle", "node_modules", ".idea", "out"}
TESTFW = [("junit-jupiter", "JUnit 5"), ("org.junit.jupiter", "JUnit 5"), ("junit:junit", "JUnit 4"),
          ("<artifactId>junit</artifactId>", "JUnit 4"), ("testng", "TestNG"), ("kotest", "Kotest"),
          ("spock", "Spock"), ("mockito", "Mockito"), ("assertj", "AssertJ"), ("mockk", "MockK"),
          ("spring-boot-starter-test", "Spring Boot Test"), ("hamcrest", "Hamcrest")]


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def strip_xml_comments(t):
    return re.sub(r"<!--.*?-->", "", t, flags=re.S)


def maven_modules(root, rel=".", depth=0):
    pom = strip_xml_comments(read(os.path.join(root, rel, "pom.xml")))
    mods = [rel]
    if depth < 3:
        for m in re.findall(r"<module>\s*([^<]+?)\s*</module>", pom):
            mods += maven_modules(root, os.path.normpath(os.path.join(rel, m)), depth + 1)
    return mods


def gradle_modules(root):
    s = read(os.path.join(root, "settings.gradle")) + read(os.path.join(root, "settings.gradle.kts"))
    mods = ["."]
    for inc in re.findall(r"include\s*\(?([^)\n]+)\)?", s):
        for name in re.findall(r"['\"]([^'\"]+)['\"]", inc):
            path = name.lstrip(":").replace(":", "/")
            m = re.search(r"project\(['\"]:%s['\"]\)\.projectDir\s*=\s*(?:file\()?['\"]([^'\"]+)" % re.escape(name.lstrip(":")), s)
            mods.append(m.group(1) if m else path)
    return mods


def count_tests(d):
    n, langs = 0, set()
    for sub in ("src/test", "src/integrationTest", "src/it"):
        base = os.path.join(d, sub)
        for b, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if x not in SKIP]
            for f in files:
                if re.search(r"(Test|Tests|IT|Spec|TestCase)\.(java|kt|groovy|scala)$", f) or \
                        re.match(r"Test\w+\.(java|kt)$", f):
                    n += 1
                    langs.add(f.rsplit(".", 1)[1])
    return n


def java_version(txt):
    for pat in (r"<maven\.compiler\.release>([^<]+)<", r"<release>([^<$]+)<", r"<maven\.compiler\.source>([^<]+)<",
                r"<java\.version>([^<]+)<", r"languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\((\d+)\)",
                r"jvmToolchain\((\d+)\)", r"sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['\"]?([\d_.]+)",
                r"jvmTarget\s*(?:=|\.set\()\s*(?:JvmTarget\.JVM_)?['\"]?([\d_.]+)"):
        m = re.search(pat, txt)
        if m:
            return m.group(1).replace("_", ".")
    return "?"


def jdk():
    if not shutil.which("java"):
        return "none on PATH"
    try:
        p = subprocess.run(["java", "-version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, timeout=20)
        m = re.search(r'version "([^"]+)"', p.stdout)
        return m.group(1) if m else p.stdout.splitlines()[0][:40]
    except (OSError, subprocess.SubprocessError):
        return "?"


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("dir", nargs="?", default=".")
    ap.add_argument("--for", dest="for_file")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.dir)
    has = lambda p: os.path.exists(os.path.join(root, p))
    maven = has("pom.xml")
    gradle = has("build.gradle") or has("build.gradle.kts") or has("settings.gradle") or has("settings.gradle.kts")
    if not maven and not gradle:
        print("no pom.xml or build.gradle(.kts) in %s" % root)
        return 0
    if maven:
        tool = "./mvnw" if has("mvnw") else "mvn"
        mods = maven_modules(root)
        build_files = [os.path.join(m, "pom.xml") for m in mods]
    else:
        tool = "./gradlew" if has("gradlew") else "gradle"
        mods = [m for m in gradle_modules(root) if os.path.isdir(os.path.join(root, m))]
        build_files = []
        for m in mods:
            for n in ("build.gradle.kts", "build.gradle"):
                if os.path.exists(os.path.join(root, m, n)):
                    build_files.append(os.path.join(m, n))
    blob = "\n".join(strip_xml_comments(read(os.path.join(root, b))) for b in build_files)
    blob += read(os.path.join(root, "gradle/libs.versions.toml"))
    if a.for_file:
        f = os.path.relpath(os.path.abspath(a.for_file), root).replace(os.sep, "/")
        mod = max((m for m in mods if m == "." or f.startswith(m.replace(os.sep, "/") + "/")),
                  key=len, default=".")
        base = os.path.splitext(os.path.basename(f))[0]
        test_names = [base] if re.search(r"(Test|Tests|IT|Spec)$", base) else \
            [base + "Test", base + "Tests", "Test" + base, base + "IT", base + "Spec"]
        found = []
        for b, dirs, files in os.walk(os.path.join(root, mod, "src")):
            dirs[:] = [x for x in dirs if x not in SKIP]
            for fn in files:
                if os.path.splitext(fn)[0] in test_names and "/test" in b.replace(os.sep, "/") + "/":
                    found.append(os.path.relpath(os.path.join(b, fn), root))
        out = ["module: %s" % (mod if mod != "." else "(root)")]
        if found:
            out.append("test class: " + ", ".join(sorted(found)[:4]))
            cls = os.path.splitext(os.path.basename(sorted(found)[0]))[0]
        else:
            cls = test_names[0]
            out.append("no test class found; create %s next to the module's other tests" % cls)
        if maven:
            pl = " -pl %s -am" % mod if mod != "." else ""
            out.append("run: %s -o -q%s test -Dtest=%s -Dsurefire.failIfNoSpecifiedTests=false" % (tool, pl, cls))
        else:
            task = ":" + mod.replace("/", ":") + ":test" if mod != "." else "test"
            out.append("run: %s --offline %s --tests '*%s'" % (tool, task, cls))
        print("\n".join(out))
        return 0
    kotlin = "kotlin" in blob
    langs = ["Java %s" % java_version(blob)] + (["Kotlin"] if kotlin else [])
    fw = []
    for key, name in TESTFW:
        if key in blob and name not in fw:
            fw.append(name)
    out = ["%s project (%s), %d module(s), %s; JDK on PATH: %s" % (
        "Maven" if maven else "Gradle " + ("Kotlin DSL" if any(b.endswith(".kts") for b in build_files) else "Groovy DSL"),
        tool, len(mods), ", ".join(langs), jdk())]
    out.append("test frameworks: " + (", ".join(fw) if fw else "none declared"))
    for m in mods[:20]:
        n = count_tests(os.path.join(root, m))
        srcs = [s for s in ("src/main/java", "src/main/kotlin", "src/test/java", "src/test/kotlin")
                if os.path.isdir(os.path.join(root, m, s))]
        if m == "." and len(mods) > 1 and not srcs:
            continue
        out.append("- %s: tests:%d  %s" % (m if m != "." else "(root)", n, " ".join(srcs)))
    if len(mods) > 20:
        out.append("(+%d more modules)" % (len(mods) - 20))
    if maven:
        out.append("build:   %s -o -q -B test-compile        (one module: -pl DIR -am)" % tool)
        out.append("test:    %s -o -q -B test                (one: -Dtest='Class#method' -Dsurefire.failIfNoSpecifiedTests=false)" % tool)
        out.append("reports: MODULE/target/surefire-reports/*.xml -> kit_run java-kotlin junit_fail.py")
    else:
        out.append("build:   %s --offline -q testClasses     (one module: :mod:testClasses)" % tool)
        out.append("test:    %s --offline test               (one: :mod:test --tests 'pkg.Class.method')" % tool)
        out.append("reports: MODULE/build/test-results/test/*.xml -> kit_run java-kotlin junit_fail.py")
    if not os.path.isdir(os.path.expanduser("~/.m2/repository")) and maven:
        out.append("WARNING: ~/.m2/repository missing: offline Maven cannot resolve plugins or dependencies")
    if gradle and not os.path.isdir(os.path.expanduser("~/.gradle/caches")):
        out.append("WARNING: ~/.gradle/caches missing: offline Gradle cannot resolve dependencies")
    if gradle and has("gradlew") and not os.access(os.path.join(root, "gradlew"), os.X_OK):
        out.append("gradlew is not executable: run it as `sh gradlew ...`")
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
