import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

export function resolveModel(
  modelId: string | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  if (modelId === undefined) {
    return undefined;
  }

  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new Error(
      `Invalid model id "${modelId}". Expected format "provider/model-id" (for example: "anthropic/claude-sonnet-4").`,
    );
  }

  const provider = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);

  try {
    const model = registry.find(provider, id);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }
    return model;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve model "${modelId}": ${message}`);
  }
}
