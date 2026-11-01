import type { LookyAskConfig } from "../config";
import { DEFAULT_MODE, MODES } from "../contract/input";
import type { ClientAdapter } from "../contract/ports";
import type { AskProjectResponse } from "../contract/response";
import { askProject, type AskProjectOptions, type AskProjectServices } from "./ask-project";

export const ASK_PROJECT_TOOL_NAME = "ask_project";

/** MCP tool definition for `ask_project`. Only `question` and `mode` are accepted. */
export function askProjectToolDefinition(config: Pick<LookyAskConfig, "maxQuestionChars">) {
  return {
    name: ASK_PROJECT_TOOL_NAME,
    description:
      "Ask a question about the authorized repository at the session's exact committed revision " +
      "and receive a complete natural-language explanation with supporting code references. " +
      'Mode "fast" (default) is a small bounded pass and may suggest "deep"; "deep" is an ' +
      "explicitly requested, larger but finite multi-step research pass. Uncommitted changes " +
      "are never read.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          maxLength: config.maxQuestionChars,
          description: "The question to answer about the repository.",
        },
        mode: {
          type: "string",
          enum: [...MODES],
          default: DEFAULT_MODE,
          description: "fast (default) or deep. Never upgraded automatically.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  } as const;
}

export interface AskProjectToolResult {
  /** Human-readable text: the full answer prose, or a status message that is not an answer. */
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  /** The complete typed response, including evidence metadata separate from the prose. */
  readonly structuredContent: AskProjectResponse;
  readonly isError: boolean;
}

/** Convert a response into an MCP tool result. Only `answered` carries answer prose. */
export function toToolResult(response: AskProjectResponse): AskProjectToolResult {
  return {
    content: [{ type: "text", text: statusText(response) }],
    structuredContent: response,
    isError: response.status !== "answered",
  };
}

function statusText(response: AskProjectResponse): string {
  switch (response.status) {
    case "answered":
      return response.answer.text;
    case "invalid_request":
      return `Invalid ask_project request (${response.error.code}): ${response.error.message}`;
    case "denied":
      return `Access denied (${response.reason}): ${response.message}`;
    case "unsupported_revision":
      return `Unsupported revision: ${response.message}`;
    case "indexing":
      return (
        `Not answered: the index for ${response.revision.sha} is still building ` +
        `(build ${response.buildId}, ${response.progress.phase}). Retry in ` +
        `${response.retryAfterMs}ms.`
      );
    case "failed":
      return (
        `Not answered: ${response.stage} failed (${response.code}): ${response.message}` +
        (response.suggestedMode ? ' You may retry explicitly with mode "deep".' : "")
      );
    case "unavailable":
      return `Not answered: Looky is temporarily unavailable: ${response.message}`;
    case "cancelled":
      return "Not answered: the request was cancelled.";
    case "timed_out":
      return `Not answered: the request exceeded its ${response.limitMs}ms time limit.`;
  }
}

/** Handle one MCP `tools/call` for ask_project with the session's client adapter. */
export async function callAskProjectTool(
  args: unknown,
  adapter: ClientAdapter,
  services: AskProjectServices,
  options: AskProjectOptions = {},
): Promise<AskProjectToolResult> {
  return toToolResult(await askProject(args, adapter, services, options));
}
