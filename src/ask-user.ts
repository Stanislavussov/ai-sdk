/**
 * ask_user - Interactive question tool for pi-coding-agent
 * 
 * Allows agents to ask users questions with selectable options or freeform input.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface QuestionOption {
  title: string;
  description?: string;
}

interface AskParams {
  question: string;
  context?: string;
  options?: (string | QuestionOption)[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  timeout?: number;
}

type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

function normalizeOptions(options: AskParams["options"]): QuestionOption[] {
  return (options ?? []).map((opt) =>
    typeof opt === "string" ? { title: opt } : opt
  );
}

function formatOptions(options: QuestionOption[]): string {
  return options
    .map((opt, i) => `${i + 1}. ${opt.title}${opt.description ? ` — ${opt.description}` : ""}`)
    .join("\n");
}

export function registerAskUserTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question with optional choices. " +
      "Use when you need user input to proceed, like confirming decisions, " +
      "selecting options, or gathering requirements.",
    promptSnippet: "Ask the user a clarifying question",
    promptGuidelines: [
      "Use ask_user when you need user input to make decisions",
      "Provide clear options when possible",
      "Include relevant context to help the user answer",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the user",
      }),
      context: Type.Optional(
        Type.String({
          description: "Additional context to help the user answer",
        })
      ),
      options: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              title: Type.String(),
              description: Type.Optional(Type.String()),
            }),
          ]),
          { description: "Available options to choose from" }
        )
      ),
      allowMultiple: Type.Optional(
        Type.Boolean({
          description: "Allow selecting multiple options (default: false)",
        })
      ),
      allowFreeform: Type.Optional(
        Type.Boolean({
          description: "Allow freeform text input (default: true)",
        })
      ),
      allowComment: Type.Optional(
        Type.Boolean({
          description: "Allow adding extra context/comment",
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const timeout = params.timeout;
      const options = normalizeOptions(params.options);

      // Build preview text
      const lines: string[] = [];
      lines.push(`❓ ${params.question}`);
      if (params.context) {
        lines.push(`📎 Context: ${params.context}`);
      }
      if (options.length > 0) {
        lines.push(`📋 Options: ${options.map((o) => o.title).join(", ")}`);
      }
      if (params.allowFreeform !== false) {
        lines.push(`✏️  Freeform: allowed`);
      }
      if (params.allowMultiple) {
        lines.push(`☑️  Multiple selection: allowed`);
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { status: "waiting" },
      });

      let response: AskResponse | null = null;

      // Use UI if available
      if (ctx.hasUI) {
        const theme = ctx.ui.theme;

        // If options provided, use select
        if (options.length > 0) {
          const optionLabels = options.map((o) => o.title);
          const selected = await ctx.ui.select(
            params.question + (params.context ? `\n\n${params.context}` : ""),
            optionLabels,
            { timeout }
          );

          if (selected) {
            response = { kind: "selection", selections: [selected] };

            // Ask for comment if allowed
            if (params.allowComment) {
              const comment = await ctx.ui.input(
                "Add a comment? (optional)",
                undefined,
                { timeout }
              );
              if (comment) {
                response.comment = comment;
              }
            }
          }
        } else {
          // Freeform input
          const answer = await ctx.ui.input(
            params.question + (params.context ? `\n\n${params.context}` : ""),
            undefined,
            { timeout }
          );

          if (answer) {
            response = { kind: "freeform", text: answer };
          }
        }
      } else {
        // No UI - use console fallback
        console.log("\n╭──────────────────────────────────────────────╮");
        console.log("│           📋 Ask User Question               │");
        console.log("╰──────────────────────────────────────────────╯\n");
        console.log(`❓ ${params.question}`);
        if (params.context) {
          console.log(`\n📎 Context: ${params.context}`);
        }
        if (options.length > 0) {
          console.log("\n📋 Options:");
          console.log(formatOptions(options));
        }
        console.log("\n✏️  Type your response and press Enter...\n");

        const answer = await new Promise<string>((resolve) => {
          const chunks: string[] = [];
          process.stdin.on("data", (chunk) => chunks.push(chunk.toString()));
          process.stdin.on("end", () => resolve(chunks.join("").trim()));
          setTimeout(() => resolve(""), timeout ?? 30000);
        });

        if (answer) {
          const matched = options.find(
            (o) => o.title.toLowerCase() === answer.toLowerCase()
          );
          if (matched) {
            response = { kind: "selection", selections: [matched.title] };
          } else {
            response = { kind: "freeform", text: answer };
          }
        }
      }

      // Format result
      if (!response) {
        return {
          content: [
            {
              type: "text" as const,
              text: "❌ Question cancelled or timed out.",
            },
          ],
          details: { cancelled: true },
        };
      }

      if (response.kind === "freeform") {
        return {
          content: [
            {
              type: "text" as const,
              text: `✏️  User responded: ${response.text}`,
            },
          ],
          details: { response, cancelled: false },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `☑️  User selected: ${response.selections.join(", ")}${
              response.comment ? ` — ${response.comment}` : ""
            }`,
          },
        ],
        details: { response, cancelled: false },
      };
    },
  });
}
