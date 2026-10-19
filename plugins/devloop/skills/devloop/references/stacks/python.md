# Python

## Test command

- The suite usually runs with `pytest`, or with `python -m unittest` when the repo uses that.
- One file runs with `pytest <file>`, and one test with `pytest <file>::<name>`.
- Run inside the project's environment, such as `uv run pytest` or `poetry run pytest`, when it has
  one.

## Gate

- Save the output and check the status, such as `pytest > test.log 2>&1 || exit 1`.

## Static checks

- Type checks use `mypy` or `pyright` when the repo configures one.
- Lint and format use `ruff`, `flake8` or `black`, as `pyproject.toml` or the hooks say.

## Size budget

- These don't count: `poetry.lock`, `uv.lock`, `Pipfile.lock` and generated code such as protobuf
  output.

## Runtime pins

- Check `.python-version`, `requires-python` in `pyproject.toml`, `.tool-versions` and the CI setup
  step.

## Hooks

- Look in `.pre-commit-config.yaml` and `.git/hooks/`.

## Gotchas

- A missing virtual environment makes the tests import the wrong packages. Create or select it in
  the preflight.
