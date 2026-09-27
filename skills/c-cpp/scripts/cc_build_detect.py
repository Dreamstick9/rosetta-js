#!/usr/bin/env python3
"""Detect a C/C++ project's build system and print the exact configure, build,
test and sanitizer-build commands: CMake (targets, tests, standard, deps),
Make (targets, CC/CFLAGS), Meson, autotools, Bazel, or loose sources.
Also reports compilers found, test frameworks, and compile_commands.json.

usage: cc_build_detect.py [DIR]
"""
import glob
import os
import re
import shutil
import sys

SKIP = {".git", "build", "out", "cmake-build-debug", "third_party", "external", "vendor", "node_modules", "_deps"}


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def walk(root, names, limit=4000):
    found, n = [], 0
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
        for f in sorted(files):
            n += 1
            if n > limit:
                return found
            if f in names or any(f.endswith(x) for x in names if x.startswith(".")):
                found.append(os.path.relpath(os.path.join(base, f), root))
    return found


def cmake(root, out):
    lists = walk(root, {"CMakeLists.txt"})
    txt = "\n".join(read(os.path.join(root, p)) for p in lists)
    proj = re.search(r"project\s*\(\s*([\w\-]+)", txt, re.I)
    exes = re.findall(r"add_executable\s*\(\s*([\w\-${}]+)", txt, re.I)
    libs = re.findall(r"add_library\s*\(\s*([\w\-${}]+)", txt, re.I)
    tests = re.findall(r"add_test\s*\(\s*(?:NAME\s+)?([\w\-${}]+)", txt, re.I)
    std = re.search(r"CMAKE_CXX_STANDARD\s+(\d+)", txt) or re.search(r"cxx_std_(\d+)", txt)
    cstd = re.search(r"CMAKE_C_STANDARD\s+(\d+)", txt)
    pkgs = sorted(set(re.findall(r"find_package\s*\(\s*(\w+)", txt, re.I)))
    fetch = re.findall(r"FetchContent_Declare\s*\(\s*(\w+)", txt, re.I)
    opts = re.findall(r"option\s*\(\s*(\w+)", txt, re.I)
    gtest_disc = "gtest_discover_tests" in txt or "GTest" in pkgs
    out.append("CMake project %s (%d CMakeLists.txt)%s%s" % (
        proj.group(1) if proj else "?", len(lists),
        ", C++%s" % std.group(1) if std else "", ", C%s" % cstd.group(1) if cstd else ""))
    if exes:
        out.append("  executables: " + ", ".join(sorted(set(exes))[:10]))
    if libs:
        out.append("  libraries: " + ", ".join(sorted(set(libs))[:10]))
    if tests or "enable_testing" in txt or gtest_disc:
        out.append("  tests: %s%s" % (", ".join(sorted(set(tests))[:10]) or "(discovered at build time)",
                                     " [gtest_discover_tests]" if gtest_disc else ""))
    if pkgs:
        out.append("  find_package: " + ", ".join(pkgs[:10]))
    if fetch:
        out.append("  FetchContent (needs network at configure time!): " + ", ".join(fetch[:6]))
    if opts:
        out.append("  options: " + ", ".join(opts[:8]))
    bdir = "build"
    if os.path.exists(os.path.join(root, "build/CMakeCache.txt")):
        out.append("  existing build dir: build/ (reuse it; reconfigure only if CMakeLists changed)")
    gen = "-G Ninja " if shutil.which("ninja") else ""
    out.append("configure: cmake -S . -B %s %s-DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON" % (bdir, gen))
    out.append("build:     cmake --build %s -j4   (one target: --target NAME)" % bdir)
    out.append("test:      ctest --test-dir %s --output-on-failure   (one: -R '^name$')" % bdir)
    out.append("asan:      cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug "
               "-DCMAKE_C_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' "
               "-DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' && cmake --build build-asan -j4")


def make(root, out, mk):
    txt = read(os.path.join(root, mk))
    targets = [t for t in re.findall(r"^([A-Za-z0-9_.\-/]+)\s*:(?!=)", txt, re.M)
               if not t.startswith(".") and "%" not in t]
    phony = re.findall(r"^\.PHONY\s*:\s*(.+)$", txt, re.M)
    cc = re.search(r"^(CC|CXX)\s*[:?]?=\s*(.+)$", txt, re.M)
    flags = re.search(r"^(CFLAGS|CXXFLAGS)\s*[:+?]?=\s*(.+)$", txt, re.M)
    out.append("Make (%s): targets %s" % (mk, ", ".join(list(dict.fromkeys(targets))[:14]) or "?"))
    if phony:
        out.append("  .PHONY: " + " ".join(" ".join(phony).split()[:12]))
    if cc:
        out.append("  %s = %s" % (cc.group(1), cc.group(2).strip()[:60]))
    if flags:
        out.append("  %s = %s" % (flags.group(1), flags.group(2).strip()[:80]))
    tt = [t for t in ("test", "check", "tests", "unittest") if t in targets]
    out.append("build: make -j4" + ("   (keep going on errors: make -k)"))
    out.append("test:  make %s" % (tt[0] if tt else "test   (no test/check target found: look for a tests/ dir or run binaries)"))
    fl = flags.group(1) if flags else "CFLAGS"
    out.append("asan:  make clean && make %s='-g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer' "
               "LDFLAGS='-fsanitize=address,undefined'   (overrides the Makefile's %s)" % (fl, fl))


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    root = os.path.abspath(argv[0] if argv else ".")
    out = []
    has = lambda p: os.path.exists(os.path.join(root, p))
    systems = []
    if has("CMakeLists.txt"):
        systems.append("cmake")
    mk = next((m for m in ("GNUmakefile", "Makefile", "makefile") if has(m)), None)
    if has("meson.build"):
        systems.append("meson")
    if has("configure.ac") or has("configure") or has("Makefile.am"):
        systems.append("autotools")
    if has("WORKSPACE") or has("MODULE.bazel") or has("BUILD.bazel"):
        systems.append("bazel")
    if has("SConstruct"):
        systems.append("scons")
    if mk:
        systems.append("make")
    if "cmake" in systems:
        cmake(root, out)
    if "meson" in systems:
        out.append("Meson: meson setup build --buildtype=debug && meson compile -C build && meson test -C build --print-errorlogs")
        out.append("  asan: meson setup build-asan -Db_sanitize=address,undefined")
    if "autotools" in systems:
        out.append("autotools: %s./configure CFLAGS='-g -O0' && make -j4 && make check   (failures in test-suite.log)"
                   % ("" if has("configure") else "autoreconf -fi && "))
    if "bazel" in systems:
        out.append("Bazel: bazel test //... --test_output=errors   (needs network for external deps)")
    if "scons" in systems:
        out.append("SCons: scons -j4")
    if mk and "cmake" not in systems:
        make(root, out, mk)
    srcs = walk(root, {".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"})
    nc = sum(1 for s in srcs if s.endswith(".c"))
    ncpp = sum(1 for s in srcs if s.endswith((".cc", ".cpp", ".cxx")))
    if not systems:
        out.append("no build system: %d .c, %d C++ source(s)" % (nc, ncpp))
        main_files = [s for s in srcs if s.endswith((".c", ".cpp", ".cc")) and
                      re.search(r"\bint\s+main\s*\(", read(os.path.join(root, s)))]
        cxx = ncpp > 0
        out.append("build: %s -g -Wall -Wextra %s -o prog %s" % (
            "c++ -std=c++17" if cxx else "cc -std=c11",
            " ".join("-I" + (d or ".") for d in sorted({os.path.dirname(h) for h in srcs
                                                       if h.endswith((".h", ".hpp"))})[:4]),
            " ".join(s for s in srcs if s.endswith((".c", ".cpp", ".cc")) and
                     (s not in main_files or s == (main_files[0] if main_files else s)))[:200]))
        if len(main_files) > 1:
            out.append("  several files define main(): " + ", ".join(main_files[:5]) + " (build them separately)")
    else:
        out.append("sources: %d .c, %d C++ file(s)" % (nc, ncpp))
    fw = []
    blob = ""
    for s in [x for x in srcs if "test" in x.lower()][:60]:
        blob += read(os.path.join(root, s))[:4000]
    for key, name in (("gtest/gtest.h", "GoogleTest (--gtest_filter=Suite.Name)"),
                      ("catch2/", "Catch2 (./test \"name\")"), ("catch.hpp", "Catch2 (./test \"name\")"),
                      ("doctest", "doctest (-tc=\"name\")"), ("unity.h", "Unity"), ("cmocka.h", "cmocka"),
                      ("check.h", "Check"), ("boost/test", "Boost.Test (--run_test=name)"),
                      ("CU_", "CUnit"), ("assert.h", "plain assert()")):
        if key in blob and name not in fw:
            fw.append(name)
    if fw:
        out.append("test framework: " + ", ".join(fw[:3]))
    cc = [c for c in ("gcc", "g++", "clang", "clang++", "cc", "c++") if shutil.which(c)]
    tools = [t for t in ("cmake", "make", "ninja", "meson", "valgrind", "c++filt") if shutil.which(t)]
    out.append("compilers: %s; tools: %s" % (", ".join(cc) or "NONE", ", ".join(tools) or "none"))
    cdb = glob.glob(os.path.join(root, "compile_commands.json")) + glob.glob(os.path.join(root, "build*/compile_commands.json"))
    if cdb:
        out.append("compile_commands.json: %s (exact flags per file)" % os.path.relpath(cdb[0], root))
    out.append("errors: kit_run c-cpp cc_errors.py --run \"<build cmd>\" | tests: cc_test_fail.py | memory: san_summary.py")
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
