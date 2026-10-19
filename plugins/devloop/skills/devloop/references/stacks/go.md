# Go

## Test command

- The suite runs with `go test ./...`, and one package with `go test ./<package>`.
- One test runs with `go test ./<package> -run '^<Name>$'`.

## Gate

- Save the output and check the status, such as `go test ./... > test.log 2>&1 || exit 1`.

## Static checks

- Run `go vet ./...`, and `golangci-lint run` when the repo configures it. Format with `gofmt`.

## Size budget

- These don't count: `go.sum`, `vendor/`, and generated files that start with a "Code generated"
  comment.

## Runtime pins

- Check the `go` and `toolchain` lines in `go.mod`, `.tool-versions` and the CI setup step.

## Hooks

- Look in `.pre-commit-config.yaml`, `lefthook.yml` and `.git/hooks/`.

## Gotchas

- Test results are cached. Use `-count=1` when a test must run again.
