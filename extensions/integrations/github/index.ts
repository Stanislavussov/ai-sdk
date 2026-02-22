import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getOctokit,
  getRepoInfo,
  loginWithToken,
  startDeviceFlowLogin,
  deleteToken,
  loadToken,
} from "./auth.js";

const NOT_AUTHED_MSG = `❌ Not authenticated with GitHub.

To log in, use one of these tools:
• **github_login_token** — paste a Personal Access Token (simplest)
• **github_login_device** — browser-based OAuth device flow

To create a Personal Access Token:
1. Go to https://github.com/settings/tokens/new
2. Select scopes: \`repo\` (full access to repositories)
3. Generate and copy the token
4. Use the **github_login_token** tool with the token`;

/**
 * Helper: ensures the user is authenticated before running a GitHub operation.
 * Returns Octokit instance or throws with a helpful login message.
 */
async function requireAuth(cwd: string) {
  const octokit = await getOctokit(cwd);
  if (!octokit) {
    throw new Error(NOT_AUTHED_MSG);
  }
  return octokit;
}

/**
 * Helper: gets owner/repo from git remote, or throws with a helpful message.
 */
async function requireRepo(cwd: string, exec: ExtensionAPI["exec"]) {
  const info = await getRepoInfo(cwd, exec as any);
  if (!info) {
    throw new Error(
      "Could not determine GitHub repository. Make sure this directory is a git repo with a GitHub remote (`git remote add origin https://github.com/owner/repo.git`).",
    );
  }
  return info;
}

export function setupGithubIntegration(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) {
  // ═══════════════════════════════════════════════════════════════════
  // AUTH TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "github_auth_status",
    label: "GitHub Auth Status",
    description:
      "Checks whether the user is authenticated with GitHub. Run this before other GitHub tools.",
    parameters: Type.Object({}),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await getOctokit(toolCtx.cwd);

      if (octokit) {
        const { data: user } = await octokit.rest.users.getAuthenticated();
        return {
          content: [
            {
              type: "text",
              text: `✅ Authenticated as **${user.login}** (${user.name || "no name set"})`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: NOT_AUTHED_MSG }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_login_token",
    label: "GitHub Login (Token)",
    description:
      "Authenticates with GitHub using a Personal Access Token. The user should create a token at https://github.com/settings/tokens/new with 'repo' scope.",
    parameters: Type.Object({
      token: Type.String({
        description:
          "GitHub Personal Access Token (starts with ghp_ or github_pat_)",
      }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const success = await loginWithToken(toolCtx.cwd, params.token);

      if (success) {
        const { Octokit } = await import("@octokit/rest");
        const octokit = new Octokit({ auth: params.token });
        const { data: user } = await octokit.rest.users.getAuthenticated();

        return {
          content: [
            {
              type: "text",
              text: `✅ Successfully authenticated as **${user.login}**! Token saved. All GitHub tools are now available.`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "❌ Invalid token. Please check the token and try again. Make sure it has the `repo` scope.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_login_device",
    label: "GitHub Login (Device Flow)",
    description:
      "Authenticates with GitHub using the OAuth device flow. Opens a browser-based authorization flow. Requires a configured OAuth App Client ID.",
    parameters: Type.Object({}),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      let verificationInfo: {
        verification_uri: string;
        user_code: string;
      } | null = null;

      try {
        const token = await startDeviceFlowLogin(
          toolCtx.cwd,
          (verification) => {
            verificationInfo = verification;
          },
        );

        const info = verificationInfo as {
          verification_uri: string;
          user_code: string;
        } | null;

        return {
          content: [
            {
              type: "text",
              text: info
                ? `🔐 To complete login:\n\n1. Open: ${info.verification_uri}\n2. Enter code: **${info.user_code}**\n\n✅ Authentication successful! Token saved.`
                : `✅ Authentication successful! Token saved.`,
            },
          ],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Device flow login failed: ${e.message}\n\n**Alternative:** Use **github_login_token** with a Personal Access Token instead.\nCreate one at: https://github.com/settings/tokens/new`,
            },
          ],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "github_logout",
    label: "GitHub Logout",
    description: "Removes the stored GitHub authentication token.",
    parameters: Type.Object({}),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      await deleteToken(toolCtx.cwd);
      return {
        content: [
          {
            type: "text",
            text: "✅ Logged out. GitHub token has been removed.",
          },
        ],
        details: {},
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // ISSUE TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "github_list_issues",
    label: "List GitHub Issues",
    description:
      "Lists issues in the current repository. Requires GitHub authentication — will suggest login if not authenticated.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.String({
          description:
            'Filter by state: "open", "closed", or "all" (default: "open")',
          default: "open",
        }),
      ),
      labels: Type.Optional(
        Type.String({
          description: "Comma-separated list of label names to filter by",
        }),
      ),
      assignee: Type.Optional(
        Type.String({ description: "Filter by assignee username" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of issues to return (default: 30)",
          default: 30,
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: (params.state as "open" | "closed" | "all") || "open",
        labels: params.labels || undefined,
        assignee: params.assignee || undefined,
        per_page: params.limit || 30,
      });

      // Filter out pull requests (GitHub API returns PRs in issues endpoint)
      const realIssues = issues.filter((i) => !i.pull_request);

      if (realIssues.length === 0) {
        return {
          content: [{ type: "text", text: "No issues found." }],
          details: {},
        };
      }

      const lines = realIssues.map((issue) => {
        const labels = issue.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean)
          .join(", ");
        const assignee = issue.assignee?.login || "unassigned";
        return `#${issue.number} [${issue.state}] ${issue.title}  (${assignee})${labels ? `  [${labels}]` : ""}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_get_issue",
    label: "Get GitHub Issue",
    description:
      "Fetches the full details and comments of a specific GitHub issue.",
    parameters: Type.Object({
      issueNumber: Type.Number({ description: "The issue number to fetch" }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      const { data: issue } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: params.issueNumber,
      });

      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: params.issueNumber,
        per_page: 100,
      });

      let text = `# #${issue.number}: ${issue.title}\n`;
      text += `**State:** ${issue.state}\n`;
      text += `**Author:** ${issue.user?.login}\n`;
      text += `**Assignees:** ${issue.assignees?.map((a) => a.login).join(", ") || "none"}\n`;
      text += `**Labels:** ${issue.labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ") || "none"}\n`;
      text += `**Created:** ${issue.created_at}\n`;
      text += `**Updated:** ${issue.updated_at}\n\n`;
      text += `## Description\n\n${issue.body || "(no description)"}\n`;

      if (comments.length > 0) {
        text += `\n## Comments (${comments.length})\n\n`;
        for (const comment of comments) {
          text += `---\n**${comment.user?.login}** (${comment.created_at}):\n${comment.body}\n\n`;
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_create_issue",
    label: "Create GitHub Issue",
    description: "Creates a new issue in the current GitHub repository.",
    parameters: Type.Object({
      title: Type.String({ description: "Title of the issue" }),
      body: Type.Optional(
        Type.String({
          description: "Body/description of the issue (Markdown supported)",
        }),
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "List of label names to add",
        }),
      ),
      assignees: Type.Optional(
        Type.Array(Type.String(), {
          description: "List of usernames to assign",
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      const { data: issue } = await octokit.rest.issues.create({
        owner,
        repo,
        title: params.title,
        body: params.body || undefined,
        labels: params.labels || undefined,
        assignees: params.assignees || undefined,
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Issue created: **#${issue.number}** — ${issue.title}\n${issue.html_url}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_comment_issue",
    label: "Comment on GitHub Issue",
    description: "Adds a comment to an existing GitHub issue.",
    parameters: Type.Object({
      issueNumber: Type.Number({
        description: "The issue number to comment on",
      }),
      body: Type.String({
        description: "The comment text (Markdown supported)",
      }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      const { data: comment } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: params.issueNumber,
        body: params.body,
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Comment added to issue #${params.issueNumber}\n${comment.html_url}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "github_close_issue",
    label: "Close GitHub Issue",
    description: "Closes a GitHub issue.",
    parameters: Type.Object({
      issueNumber: Type.Number({ description: "The issue number to close" }),
      reason: Type.Optional(
        Type.String({
          description:
            'Reason: "completed" or "not_planned" (default: "completed")',
          default: "completed",
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: params.issueNumber,
        state: "closed",
        state_reason:
          (params.reason as "completed" | "not_planned") || "completed",
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Issue #${params.issueNumber} closed (${params.reason || "completed"}).`,
          },
        ],
        details: {},
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // PR TOOLS
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "github_list_prs",
    label: "List Pull Requests",
    description: "Lists pull requests in the current GitHub repository.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.String({
          description:
            'Filter by state: "open", "closed", or "all" (default: "open")',
          default: "open",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of PRs to return (default: 10)",
          default: 10,
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
      const octokit = await requireAuth(toolCtx.cwd);
      const { owner, repo } = await requireRepo(toolCtx.cwd, pi.exec);

      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: (params.state as "open" | "closed" | "all") || "open",
        per_page: params.limit || 10,
      });

      if (prs.length === 0) {
        return {
          content: [{ type: "text", text: "No pull requests found." }],
          details: {},
        };
      }

      const lines = prs.map((pr) => {
        return `#${pr.number} [${pr.state}] ${pr.title}  (${pr.user?.login || "unknown"})  ${pr.head.ref} → ${pr.base.ref}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
  // ═══════════════════════════════════════════════════════════════════
  // SLASH COMMANDS (user-facing, type /command in PI)
  // ═══════════════════════════════════════════════════════════════════

  pi.registerCommand("github-status", {
    description: "Check GitHub authentication status",
    handler: async (args, ctx) => {
      const octokit = await getOctokit(ctx.cwd);
      if (octokit) {
        const { data: user } = await octokit.rest.users.getAuthenticated();
        ctx.ui.notify(
          `✅ Authenticated as ${user.login} (${user.name || "no name"})`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "❌ Not authenticated. Use /github-login to log in.",
          "warning",
        );
      }
    },
  });

  pi.registerCommand("github-login", {
    description: "Log in to GitHub with a Personal Access Token",
    handler: async (args, ctx) => {
      const token = args.trim();

      if (!token) {
        // Prompt for token via UI input
        const inputToken = await ctx.ui.input(
          "Enter your GitHub Personal Access Token",
          "ghp_... or github_pat_...",
        );
        if (!inputToken) {
          ctx.ui.notify("Login cancelled.", "info");
          return;
        }
        const success = await loginWithToken(ctx.cwd, inputToken);
        if (success) {
          const { Octokit } = await import("@octokit/rest");
          const oc = new Octokit({ auth: inputToken });
          const { data: user } = await oc.rest.users.getAuthenticated();
          ctx.ui.notify(`✅ Logged in as ${user.login}!`, "info");
        } else {
          ctx.ui.notify(
            "❌ Invalid token. Check scopes (need 'repo').",
            "error",
          );
        }
        return;
      }

      // Token was passed as argument
      const success = await loginWithToken(ctx.cwd, token);
      if (success) {
        const { Octokit } = await import("@octokit/rest");
        const oc = new Octokit({ auth: token });
        const { data: user } = await oc.rest.users.getAuthenticated();
        ctx.ui.notify(`✅ Logged in as ${user.login}!`, "info");
      } else {
        ctx.ui.notify("❌ Invalid token.", "error");
      }
    },
  });

  pi.registerCommand("github-logout", {
    description: "Log out from GitHub",
    handler: async (args, ctx) => {
      await deleteToken(ctx.cwd);
      ctx.ui.notify("✅ Logged out from GitHub.", "info");
    },
  });

  pi.registerCommand("github-issues", {
    description: "List GitHub issues (usage: /github-issues [open|closed|all])",
    handler: async (args, ctx) => {
      const octokit = await getOctokit(ctx.cwd);
      if (!octokit) {
        ctx.ui.notify(
          "❌ Not authenticated. Use /github-login first.",
          "warning",
        );
        return;
      }

      const repoInfo = await getRepoInfo(ctx.cwd, pi.exec as any);
      if (!repoInfo) {
        ctx.ui.notify(
          "❌ No GitHub remote found. Make sure this is a git repo with a GitHub remote.",
          "error",
        );
        return;
      }

      const state = (args.trim() || "open") as "open" | "closed" | "all";
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        state,
        per_page: 30,
      });

      const realIssues = issues.filter((i) => !i.pull_request);

      if (realIssues.length === 0) {
        ctx.ui.notify(`No ${state} issues found.`, "info");
        return;
      }

      // Send as a message so the AI and user can both see the issues
      const lines = realIssues.map((issue) => {
        const labels = issue.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean)
          .join(", ");
        return `#${issue.number} [${issue.state}] ${issue.title}${labels ? ` [${labels}]` : ""}`;
      });

      pi.sendUserMessage(
        `Here are the ${state} GitHub issues:\n\n${lines.join("\n")}`,
      );
    },
  });

  // Notify user that integration is active
  ctx.ui?.notify("GitHub integration enabled.", "info");
}
