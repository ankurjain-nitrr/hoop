# Rust

## Test command

- The suite runs with `cargo test`, and `cargo test --workspace` covers every crate.
- One test runs with `cargo test <name>`.

## Gate

- Save the output and check the status, such as `cargo test > test.log 2>&1 || exit 1`.

## Static checks

- Run `cargo clippy` and `cargo fmt --check` when the repo uses them.

## Size budget

- These don't count: `Cargo.lock` and generated code.

## Runtime pins

- Check `rust-toolchain.toml` or `rust-toolchain`, `rust-version` in `Cargo.toml` and the CI setup
  step.

## Hooks

- Look in `.pre-commit-config.yaml` and `.git/hooks/`.

## Gotchas

- Feature flags change what compiles. Run the tests with the features that CI uses.
