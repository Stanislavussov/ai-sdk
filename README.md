# ai-sdk

Multi-agent orchestration for [pi](https://github.com/badlogic/pi-mono). Define specialized agents with dependency graphs — the orchestrator resolves execution order and runs independent agents in parallel waves.

## Installation

In your consumer project:

```bash
npm install ai-sdk
```

## Quick Start

Create `.pi/settings.json` in your project — one file, everything in one place (see [`examples/settings.json`](examples/settings.json) for a copy-paste starting point):

```json
{
  "$schema": "./node_modules/ai-sdk/schema.json",
  "packages": ["ai-sdk"],
  "orchestrator": {
    "model": "anthropic/claude-sonnet-4-5",
    "thinkingLevel": "high",
    "agents": [
      {
        "name": "schema",
        "role": "Database schema using Drizzle ORM",
        "type": "coding",
        "rules": "Use Drizzle ORM, PostgreSQL dialect. snake_case columns. Every table: id (uuid), created_at, updated_at.",
        "skills": ["./skills/schema"],
        "dependsOn": []
      },
      {
        "name": "dal",
        "role": "Data access layer using TanStack Query",
        "type": "coding",
        "rules": "TanStack Query for all data fetching. One hook file per entity. All mutations invalidate parent queries.",
        "skills": ["./skills/dal"],
        "dependsOn": ["schema"]
      },
      {
        "name": "bl",
        "role": "Business logic via Next.js Server Actions",
        "type": "coding",
        "rules": "Server Actions only, no API routes. Zod validation on every input.",
        "skills": ["./skills/bl"],
        "dependsOn": ["schema"]
      },
      {
        "name": "ui",
        "role": "React UI components",
        "type": "coding",
        "model": "anthropic/claude-opus-4-5",
        "rules": "shadcn/ui components only. cn() for className merging. No inline styles.",
        "skills": ["./skills/ui"],
        "dependsOn": ["dal", "bl"]
      },
      {
        "name": "reviewer",
        "role": "Code reviewer",
        "type": "readonly",
        "rules": "Review all generated code for correctness, consistency, and best practices.",
        "dependsOn": ["ui"]
      }
    ]
  }
}
```

The `$schema` field gives you autocomplete and validation in VS Code — model names, agent types, tool names, everything.

### Usage

Open pi in your project. The extension auto-loads and you can:

#### Run the full pipeline

- **Ask the LLM:** _"Run the orchestrator to add user authentication"_ → calls the `orchestrate` tool
- **Command:** `/orchestrate Add a users table with email/password auth`

```
→ Wave 0: [schema]
  ▶ schema starting (anthropic/claude-sonnet-4-5)
  ✓ schema: Created users table with email, password_hash, ...

→ Wave 1: [dal, bl]          ← runs in parallel
  ▶ dal starting (anthropic/claude-sonnet-4-5)
  ▶ bl starting (anthropic/claude-sonnet-4-5)
  ✓ dal: Created useUsers, useUser hooks
  ✓ bl: Created auth server actions

→ Wave 2: [ui]
  ▶ ui starting (anthropic/claude-opus-4-5)
  ✓ ui: Created LoginForm, ProfileSettings components

→ Wave 3: [reviewer]
  ▶ reviewer starting (anthropic/claude-sonnet-4-5)
  ✓ reviewer: All layers consistent, no issues found

✓ Orchestration complete — 5 agents finished
```

#### Run a single agent

Target one specific agent without running the full pipeline:

- **Ask the LLM:** _"Run the schema agent to add a posts table"_ → calls the `run_agent` tool
- **Command:** `/agent schema Add a posts table with title and body`

```
▶ Running agent "schema" (anthropic/claude-sonnet-4-5)...
✓ Agent "schema" complete.

Summary: Created posts table with title, body, author_id columns
Files: src/db/schema.ts
Exports:
  postsTable → src/db/schema.ts
  PostInsert → src/db/schema.ts
```

The LLM can also define agents inline — no config needed:

> _"Run an agent named 'auditor' with role 'security auditor' and rules 'check for SQL injection and XSS' to review the auth module"_

#### List configured agents

- **Command:** `/orch-agents`

```
Configured agents (5):
  • schema (coding, anthropic/claude-sonnet-4-5) — Database schema using Drizzle ORM [no dependencies]
  • dal (coding, anthropic/claude-sonnet-4-5) — Data access layer using TanStack Query [depends on: schema]
  • bl (coding, anthropic/claude-sonnet-4-5) — Business logic via Next.js Server Actions [depends on: schema]
  • ui (coding, anthropic/claude-opus-4-5) — React UI components [depends on: dal, bl]
  • reviewer (readonly, anthropic/claude-sonnet-4-5) — Code reviewer [depends on: ui]

Run one:  /agent <name> <task>
Run all:  /orchestrate <task>
List:     /orch-agents
```

## Config Reference

Everything lives under the `"orchestrator"` key in `.pi/settings.json`.

### Top-level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | `string` | no | Default model for all agents (`"provider/model-id"`) |
| `thinkingLevel` | `string` | no | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` |
| `manifestDir` | `string` | no | Temp directory for manifest exchange (defaults to OS temp) |
| `agents` | `array` | **yes** | Agent pipeline definitions |

### Agent Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | **yes** | Unique identifier |
| `role` | `string` | **yes** | What this agent is responsible for |
| `rules` | `string` | **yes** | Constraints, style rules, guidelines |
| `dependsOn` | `string[]` | no | Agents that must complete first |
| `model` | `string` | no | Model override (`"provider/model-id"`) |
| `type` | `string` | no | Tool preset (see below) |
| `enabledTools` | `string[]` | no | Cherry-pick tools (overrides `type`) |
| `skills` | `string[]` | no | Skill directory paths (relative to project root) |
| `thinkingLevel` | `string` | no | Thinking level override |

### Agent Types

| Type | Tools | Use for |
|------|-------|---------|
| `"coding"` (default) | read, bash, edit, write | Agents that create/modify files |
| `"readonly"` | read, grep, find, ls | Reviewers, analyzers, planners |
| `"all"` | read, bash, edit, write, grep, find, ls | Full access |
| `"none"` | _(none)_ | Agents with only custom tools |

### Cherry-picking Tools

```json
{
  "name": "auditor",
  "role": "Security auditor",
  "rules": "Check for SQL injection, XSS, auth bypasses",
  "enabledTools": ["read", "grep", "bash"],
  "dependsOn": ["bl"]
}
```

Valid names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Dependency Graph

Agents with no `dependsOn` run first. Independent agents in the same wave run in parallel. Cycles are detected.

```
schema ──┬──→ dal ──┬──→ ui ──→ reviewer
         └──→ bl  ──┘
```

Wave 0: `[schema]` → Wave 1: `[dal, bl]` → Wave 2: `[ui]` → Wave 3: `[reviewer]`

## Project Structure

```
my-project/
├── .pi/
│   └── settings.json      ← packages + orchestrator config, all in one
├── skills/                 ← optional skill directories for agents
│   ├── schema/
│   │   └── SKILL.md
│   └── ui/
│       └── SKILL.md
└── src/
    └── ...
```
