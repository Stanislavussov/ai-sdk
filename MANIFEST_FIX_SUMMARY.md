# i18n Manifest File Fix Summary

## Problem
The orchestrator was failing with the error:
```
Wave 1: Agent "i18n" did not write manifest file:
/var/folders/.../T/i18n-manifest-xxxxx.json
```

This occurred because agents weren't consistently writing their manifest files, causing orchestration to fail.

## Root Cause
Agents must write a manifest JSON file using the `write` tool when they complete their work. However:
1. The prompts weren't clear enough about this critical requirement
2. Agents could complete without writing the manifest
3. There was no validation that agents had the necessary `write` tool

## Changes Made

### 1. Enhanced System Prompt (`src/arch-agents/prompts/prompts.ts`)
Made the manifest writing requirement much more explicit:
- Added ⚠️ visual warnings
- Numbered the critical responsibilities
- Provided a concrete example of the JSON structure
- Emphasized that orchestration will fail without the manifest

**Before:**
```typescript
"- When complete, write manifest JSON to the path in the task prompt"
"- Manifest schema: { changedFiles, summary, exports }"
```

**After:**
```typescript
"2. When complete, YOU MUST write a manifest JSON file to the path specified in the task prompt"
"   - Use the 'write' tool with the exact path provided"
"   - Write pure JSON only (no markdown fences, no extra text)"
"   - Use schema: { changedFiles: string[], summary: string, exports: Record<string,string> }"
"   - Example: { \"changedFiles\": [\"src/api.ts\"], \"summary\": \"Added API\", \"exports\": { \"API\": \"src/api.ts:1\" } }"
"3. DO NOT finish your response until the manifest file is written"
"4. The orchestration will FAIL if you don't write the manifest file"
```

### 2. Enhanced Task Prompt (`src/arch-agents/prompts/prompts.ts`)
Completely rewrote the task prompt to be impossible to miss:
- Added large ⚠️ warning headers
- Provided step-by-step instructions
- Included a concrete example
- Made it clear this is a CRITICAL requirement

**Before:**
```typescript
"## Required: write your manifest"
`Write valid JSON (no markdown fences) to: ${manifestPath}`
"Schema: { changedFiles: string[], summary: string, exports: Record<string,string> }"
"Do not stop until the manifest file has been written."
```

**After:**
```typescript
"## ⚠️ CRITICAL REQUIREMENT: Write Manifest File ⚠️"
""
"YOU MUST COMPLETE THIS STEP - DO NOT FINISH WITHOUT DOING THIS:"
""
`1. Use the 'write' tool to create the file: ${manifestPath}`
"2. Write ONLY valid JSON (no markdown code fences, no extra text)"
"3. Use this exact schema:"
"   {"
'     "changedFiles": ["array", "of", "file", "paths"],'
'     "summary": "brief description of what you did",'
'     "exports": { "SymbolName": "file.ts:lineNumber" }'
"   }"
""
"Example:"
'{ "changedFiles": ["src/api.ts"], "summary": "Added user endpoint", "exports": { "UserAPI": "src/api.ts:10" } }'
""
"⚠️ THE ORCHESTRATOR WILL FAIL IF YOU DON'T WRITE THIS FILE ⚠️"
"Do not respond with completion until the manifest file has been written using the write tool."
```

### 3. Added Write Tool Validation (`src/arch-agents/agent/agent-factory.ts`)
Added runtime validation to ensure agents have the `write` tool:

```typescript
// Validate that agent has write tool (required for manifest)
const hasWriteTool = builtinTools.some((tool) =>
  tool.name === "write" || tool.name === "Write"
);
if (!hasWriteTool) {
  throw new Error(
    `Agent "${def.name}" must have the "write" tool to create its manifest. ` +
    `Current type: "${def.type ?? "coding"}". ` +
    `Use type="coding" or type="all", or add "write" to enabledTools.`
  );
}
```

This catches configuration errors early before the agent runs.

### 4. Updated Tests
- Fixed test mocks to work with the new prompt format
- Updated regex pattern to extract manifest paths from the new format
- Added tests for agents that don't have the write tool
- Updated prompt assertion tests to match new text

## Why This Fixes the Problem

1. **Clearer Requirements**: The new prompts make it impossible for an agent to miss the requirement to write the manifest file
2. **Visual Emphasis**: The ⚠️ warnings and all-caps headers catch attention
3. **Step-by-Step Instructions**: Agents now have explicit instructions on how to write the manifest
4. **Concrete Examples**: Providing an example helps agents understand exactly what to write
5. **Early Validation**: The write tool check catches configuration errors before agents run
6. **Explicit Tool Usage**: The prompt now explicitly tells agents to use the 'write' tool

## Configuration Recommendations

For your agents in `.pi/settings.json`:

1. **Use `type: "coding"`** (default) - includes read, bash, edit, and write tools
2. **Or use `type: "all"`** - includes all available tools
3. **Or explicitly add write tool**:
   ```json
   {
     "name": "i18n",
     "type": "readonly",
     "enabledTools": ["read", "write"]
   }
   ```

**Avoid** using `type: "readonly"` or `type: "none"` without adding the write tool to `enabledTools`.

## Testing
All 168 tests pass, including:
- Agent manifest writing
- Tool resolution
- Error handling for missing write tool
- Prompt format validation
