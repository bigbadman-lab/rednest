/**
 * The prompt a person pastes into their coding agent to have it set RedNest
 * up for them. Built from the site's own address (the browser's, for the
 * copy buttons), so it is right on self-hosted servers too.
 */
export function setupPrompt(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `Set up RedNest for me: it finds exploitable vulnerabilities in my GitHub repositories (${base}).
Read ${base}/docs/agents.md and follow it. Connect to its MCP server (${base}/api/mcp) if you can add one, otherwise use its HTTP API with the device flow.
Then call get_me and work through next_steps. Only ask me for what needs me: approving the connection and installing the GitHub App. Do not assume payment or free credits are available.`;
}
