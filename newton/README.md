# newton

`newton` starts Claude Code with hoop, the todo tools and Claude in Chrome always on. Every argument
passes through to `claude` (`newton -p "..."`, `newton --resume`); its own commands (`newton plugin
list`, `newton mcp`, `newton update` and the rest) run without the session flags.

- `bin/newton` finds the real `claude` on your PATH (or `NEWTON_CLAUDE`), installs the hoop plugin
  once if it's missing, and runs `claude --chrome --settings settings.json`.
- `settings.json` turns on the hoop plugin and `CLAUDE_CODE_ENABLE_TODO_TOOLS` for newton's sessions
  only; plain `claude` and `~/.claude/settings.json` are unchanged.

Install by linking it onto your PATH from a clone:

```sh
ln -s "$PWD/newton/bin/newton" ~/.local/bin/newton
```

For the single TodoWrite list instead of the Task tools, start it with
`CLAUDE_CODE_ENABLE_TASKS=0 newton`.
