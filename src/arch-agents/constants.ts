/**
 * Single source of truth for all enum values.
 * TypeScript types AND the JSON schema are derived from these arrays.
 */

// ── Thinking levels ────────────────────────────────────────

export const THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// ── Agent types ────────────────────────────────────────────

export const AGENT_TYPES = [
  "coding", "readonly", "all", "none",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

// ── Tool names ─────────────────────────────────────────────

export const TOOL_NAMES = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ── Known models ───────────────────────────────────────────

export const KNOWN_MODELS = [
  // Anthropic
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-4-0",
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-5-20251101",
  "anthropic/claude-opus-4-1",
  "anthropic/claude-opus-4-1-20250805",
  "anthropic/claude-opus-4-0",
  "anthropic/claude-opus-4-20250514",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-3-7-sonnet-20250219",
  "anthropic/claude-3-7-sonnet-latest",
  "anthropic/claude-3-5-sonnet-20241022",
  "anthropic/claude-3-5-haiku-20241022",
  "anthropic/claude-3-5-haiku-latest",

  // OpenAI
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
  "openai/gpt-5.2",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.2-pro",
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5",
  "openai/gpt-5-codex",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5-pro",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o4-mini",
  "openai/o3",
  "openai/o3-mini",
  "openai/o3-pro",
  "openai/o1",
  "openai/o1-pro",
  "openai/codex-mini-latest",

  // Google
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.0-flash",
  "google/gemini-2.0-flash-lite",
  "google/gemini-1.5-pro",
  "google/gemini-1.5-flash",

  // xAI
  "xai/grok-4",
  "xai/grok-4-fast",
  "xai/grok-4-1-fast",
  "xai/grok-3",
  "xai/grok-3-fast",
  "xai/grok-3-mini",
  "xai/grok-3-mini-fast",
  "xai/grok-code-fast-1",
  "xai/grok-2",

  // Mistral
  "mistral/devstral-medium-latest",
  "mistral/devstral-small-2507",
  "mistral/mistral-large-latest",
  "mistral/mistral-medium-latest",
  "mistral/mistral-small-latest",
  "mistral/codestral-latest",
  "mistral/magistral-medium-latest",

  // Groq
  "groq/llama-3.3-70b-versatile",
  "groq/llama-3.1-8b-instant",
  "groq/deepseek-r1-distill-llama-70b",
  "groq/gemma2-9b-it",
] as const;

export type KnownModelId = (typeof KNOWN_MODELS)[number];

/**
 * Accepts any known model for autocomplete, plus any "provider/model-id" string.
 */
export type ModelId = KnownModelId | (string & {});
