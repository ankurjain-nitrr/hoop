// The MCP clients hoop supports (README, "Other agents") and how long each lets one tool call run,
// with where that number comes from. A wait that outlasts its client's limit is cut off by the
// client, so hoop_wait and hoop_build_wait hold for less: test/clients.test.ts checks every default
// wait against this table with MARGIN_SECONDS to spare. Only Claude Code also wakes on its own:
// hoop messages its session when a review arrives, so it need not call hoop_wait at all.

export type Client = {
  name: string;
  /** Whether hoop sees it as Claude Code (CLAUDE_CODE_SESSION_ID), which gets the long default wait. */
  claude: boolean;
  /** The longest one tool call may run, in seconds, under the client's defaults. */
  toolCallSeconds: number;
  /** Where that number comes from. */
  source: string;
  /** Whether hoop can message the session when a review arrives, so the agent doesn't have to poll. */
  wakes: boolean;
};

export const CLIENTS: Client[] = [
  {
    name: "Claude Code",
    claude: true,
    // MCP_TOOL_TIMEOUT is about 28 hours, but a call that sends nothing for
    // CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ends sooner, and hoop_wait sends nothing. That is 30 minutes
    // for a stdio server, as hoop is, and 5 for a network server, which hoop never runs as.
    toolCallSeconds: 30 * 60,
    source:
      "https://code.claude.com/docs/en/env-vars: CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, 1800000 ms for stdio servers (300000 ms for network servers); MCP_TOOL_TIMEOUT is about 28 hours",
    wakes: true,
  },
  {
    name: "Codex CLI",
    claude: false,
    toolCallSeconds: 60,
    source: "https://learn.chatgpt.com/docs/config-file/config-reference: mcp_servers.<id>.tool_timeout_sec, default 60 s",
    wakes: false,
  },
  {
    name: "Cursor",
    claude: false,
    toolCallSeconds: 60,
    source:
      "https://forum.cursor.com/t/agent-acp-mcp-tools-call-times-out-at-60s-with-no-way-to-configure-it/163925: a forum report that tools/call ends at about 60 s; Cursor publishes no figure",
    wakes: false,
  },
  {
    name: "Gemini CLI",
    claude: false,
    toolCallSeconds: 600,
    source: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md: timeout, default 600,000 ms",
    wakes: false,
  },
  {
    name: "OpenCode",
    claude: false,
    // Its v2 default gives tool calls 12 hours; the README's config sets timeout to 60,000 ms, the
    // lower of the two, which hoop must fit either way.
    toolCallSeconds: 60,
    source: "https://opencode.ai/v2/docs/mcp-servers/: execution timeout, default 12 hours; the README's OpenCode config sets timeout 60000 ms",
    wakes: false,
  },
  {
    name: "Any client built on the MCP SDK",
    claude: false,
    toolCallSeconds: 60,
    source: "@modelcontextprotocol/sdk: DEFAULT_REQUEST_TIMEOUT_MSEC, 60,000 ms",
    wakes: false,
  },
];

/** How much sooner than its client's limit a wait ends, so its answer reaches the client in time. */
export const MARGIN_SECONDS = 15;
