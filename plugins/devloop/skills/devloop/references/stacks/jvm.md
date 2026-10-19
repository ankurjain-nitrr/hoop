# Java and Kotlin (Gradle or Maven)

## Test command

- Gradle runs the suite with `./gradlew test`, and one class with `./gradlew test --tests
  '<Class>'`.
- Maven runs the suite with `./mvnw test` or `mvn test`, and one class with `-Dtest=<Class>`.
- Multi-module builds may need `build` or `check` to run every module's tests.

## Gate

- Save the output and check the status, such as `./gradlew test > test.log 2>&1 || exit 1`.

## Static checks

- The compiler is the type check. Linters such as Checkstyle, SpotBugs, ktlint or detekt run in
  `check` when the build configures them.

## Size budget

- These don't count: the wrapper files, `gradle/verification-metadata.xml`, lock files such as
  `gradle.lockfile`, and generated sources.

## Runtime pins

- Check the toolchain block, `sourceCompatibility` or the compiler `release` flag, the wrapper
  properties, `Dockerfile` base images and the CI setup step.

## Hooks

- Look in `.git/hooks/` and in build plugins that install hooks.

## Gotchas

- The installed JDK can differ from the toolchain the build asks for. Check both in the preflight.
