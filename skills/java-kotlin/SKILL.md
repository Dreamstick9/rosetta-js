---
name: java-kotlin
internal: true
description: "Java and Kotlin on Maven or Gradle: javac/kotlinc errors, failing JUnit/TestNG/Kotest tests, surefire reports, stack traces, multi-module builds."
triggers:
  keywords: [java, kotlin, maven, gradle, mvn, gradlew, pom.xml, junit, testng, kotest, surefire, spring, jvm, javac, kotlinc, nullpointerexception, stack trace, exception, jar, classpath, mockito]
  files: [pom.xml, build.gradle, build.gradle.kts, settings.gradle, settings.gradle.kts, mvnw, gradlew, "*.java", "*.kt"]
tools:
  - script: scripts/jvm_detect.py
    usage: "jvm_detect.py [DIR] [--for FILE] → Maven/Gradle, modules, Java/Kotlin version, test frameworks, test counts, offline commands; --for: module + test class + command"
  - script: scripts/jvm_errors.py
    usage: "jvm_errors.py [FILE|-] [--run CMD] → first javac/kotlinc error per file with source line, symbol/location, hint; failing module/task; offline resolution failures"
  - script: scripts/junit_fail.py
    usage: "junit_fail.py [DIR|XML|LOG ...] [--run CMD] → failing tests from surefire/Gradle XML or console: exception, message, project frames, rerun command"
  - script: scripts/jvm_stack.py
    usage: "jvm_stack.py FILE|- [--pkg com.acme] → exception chain with project frames only, framework frames folded, root cause marked"
checks:
  - mvn -o -q -B test
  - ./gradlew --offline test
---
# Java and Kotlin

## When it applies
- The repo has `pom.xml` or `build.gradle(.kts)` and the task is a compile error, a failing test, an
  exception in a log, a bug or a feature in Java or Kotlin.
- The task mentions Maven, Gradle, JUnit, surefire, NullPointerException or a stack trace.

## Workflow
1. `python3 skills/java-kotlin/scripts/jvm_detect.py`: build tool and wrapper, modules, Java release, test framework,
   and the exact offline commands. `jvm_detect.py --for path/Foo.java` gives the module, `FooTest` and
   the command to run just that test class.
2. Compile: `python3 skills/java-kotlin/scripts/jvm_errors.py` (runs `test-compile` / `testClasses` offline). Fix the
   first error per file; a missing symbol in one class cascades into its users.
3. Tests: `python3 skills/java-kotlin/scripts/junit_fail.py --run "mvn -o -q -B test -pl core -am -Dtest=FooTest -Dsurefire.failIfNoSpecifiedTests=false"`
   or `--run "./gradlew --offline :core:test --tests 'pkg.FooTest'"`. Without `--run` it reads the XML
   reports already on disk (`target/surefire-reports`, `build/test-results`).
4. An exception in a log or console: `python3 skills/java-kotlin/scripts/jvm_stack.py app.log` shows the chain with
   project frames only; start from the ROOT CAUSE line.
5. Write the regression test beside the existing ones (same framework, same assertion style), run it
   red, fix, run it green, then the whole module, then the full build.

## Offline builds
- Always pass `-o` (Maven) / `--offline` (Gradle): there is no network. A "Cannot access central in
  offline mode" / "No cached version" error means an artifact is not cached: do not add or upgrade
  dependencies or plugins; use what the project already declares.
- Use the wrapper (`./mvnw`, `./gradlew`) when present; `sh gradlew` if it is not executable.
- Maven multi-module: `-pl MODULE -am` builds the module and what it depends on; `-Dtest=` needs
  `-Dsurefire.failIfNoSpecifiedTests=false` so other modules do not fail for having no match.
- If the build tool cannot start at all offline, type-check with plain `javac -d $TMPDIR/out` over the
  sources plus the jars in `~/.m2/repository` as classpath, and say so in the report.

## Rules
- Keep the language level: no records/switch patterns/`var` above the project's `release`/`jvmTarget`.
- Keep public signatures, Spring bean names and serialized field names stable unless asked.
- `equals` and `hashCode` change together; collections of mutable keys break when the key changes.
- Kotlin: respect nullability; do not silence the compiler with `!!`; prefer `?.`, `?:` and early returns.
- Close resources with try-with-resources (`use {}` in Kotlin).
- Do not catch `Exception` broadly to make a test pass; do not add `@Disabled`/`@Ignore`.

## Checklist
- [ ] Reproduced (failing test or compile error) before editing
- [ ] `test-compile`/`testClasses` clean for the touched modules
- [ ] Regression test added in the existing framework; it failed before the fix
- [ ] Module tests pass, then the full build (`mvn -o -q test` / `./gradlew --offline test`)
- [ ] No new dependencies or plugin versions; build files unchanged unless required
- [ ] No disabled tests, no broad catch blocks

## Pitfalls
- `-Dtest=Foo` without `-Dsurefire.failIfNoSpecifiedTests=false` fails other modules in a reactor build.
- JUnit 4 vs 5 mix: `org.junit.Test` with the JUnit 5 engine is silently not run (0 tests). Match the
  imports of neighboring tests; JUnit 5 test classes and methods need not be public.
- Surefire only runs classes named `*Test`, `Test*`, `*Tests`, `*TestCase` by default; `*IT` runs in
  failsafe (`verify`).
- Stale output: after renaming or moving classes, run `clean` for that module if odd errors persist.
- `assertEquals(expected, actual)` order in JUnit (reversed in some Kotlin libraries); read the message.
- Integer caching: `Integer == Integer` works for -128..127 only; use `equals`.
- `List.of(...)`/`Map.of(...)` are immutable and reject nulls; `Arrays.asList` is fixed-size.
- Time zones and default locale in formatting/parsing make tests machine-dependent; pass them explicitly.
- Kotlin `data class` `copy()` is shallow; platform types from Java can be null at runtime.

## Research (web_search / web_fetch)
- JDK API and the version that added it: `https://docs.oracle.com/en/java/javase/21/docs/api/` (the "Since" tag).
- Kotlin stdlib: `https://kotlinlang.org/api/core/kotlin-stdlib/`.
- Maven Surefire options (`-Dtest` patterns, includes): `https://maven.apache.org/surefire/maven-surefire-plugin/`.
- Gradle test filtering: `https://docs.gradle.org/current/userguide/java_testing.html`.
- JUnit 5 assertions and parameterized tests: `https://junit.org/junit5/docs/current/user-guide/`.
