import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Runs a tool body and turns its return value (or thrown error) into an MCP tool result. */
export async function toResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
}
