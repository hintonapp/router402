/**
 * Model Registry
 *
 * Single source of truth for all supported models, their provider mappings,
 * pricing, and feature capabilities. All model-related data should be derived
 * from this registry.
 *
 * @module models/registry
 */

// ============================================================================
// Feature Type
// ============================================================================

export type ModelFeature = "thinking" | "web_search";

// ============================================================================
// Model Definition
// ============================================================================

export interface ModelDefinition {
  /** Human-readable model name */
  name: string;
  /** Provider-specific model identifier */
  providerId: string;
  /** Pricing per million tokens (USD) */
  pricing: {
    input: number;
    output: number;
  };
  /** Supported features */
  features: ModelFeature[];
}

// ============================================================================
// Provider Type
// ============================================================================

export type Provider = keyof typeof MODEL_REGISTRY;

// ============================================================================
// Registry
// ============================================================================

export const MODEL_REGISTRY = {
  anthropic: {
    "anthropic/claude-opus-4.7": {
      name: "Claude Opus 4.7",
      providerId: "claude-opus-4-7",
      pricing: { input: 5.0, output: 25.0 },
      features: ["web_search"],
    },
    "anthropic/claude-sonnet-4.6": {
      name: "Claude Sonnet 4.6",
      providerId: "claude-sonnet-4-6",
      pricing: { input: 3.0, output: 15.0 },
      features: ["thinking", "web_search"],
    },
    "anthropic/claude-haiku-4.5": {
      name: "Claude Haiku 4.5",
      providerId: "claude-haiku-4-5-20251001",
      pricing: { input: 1.0, output: 5.0 },
      features: ["thinking", "web_search"],
    },
  },
  google: {
    "google/gemini-3.1-pro-preview": {
      name: "Gemini 3.1 Pro",
      providerId: "gemini-3.1-pro-preview",
      pricing: { input: 2.0, output: 12.0 },
      features: ["thinking", "web_search"],
    },
    "google/gemini-3.1-flash-lite-preview": {
      name: "Gemini 3.1 Flash Lite",
      providerId: "gemini-3.1-flash-lite-preview",
      pricing: { input: 0.25, output: 1.5 },
      features: ["thinking", "web_search"],
    },
  },
  qwen: {
    "qwen/qwen3-max": {
      name: "Qwen3 Max",
      providerId: "qwen3-max",
      pricing: { input: 1.2, output: 6.0 },
      features: ["thinking", "web_search"],
    },
    "qwen/qwen3.5-plus": {
      name: "Qwen3.5 Plus",
      providerId: "qwen3.5-plus",
      pricing: { input: 0.4, output: 2.4 },
      features: ["thinking", "web_search"],
    },
    "qwen/qwen3.5-flash": {
      name: "Qwen3.5 Flash",
      providerId: "qwen3.5-flash",
      pricing: { input: 0.1, output: 0.4 },
      features: ["thinking", "web_search"],
    },
  },
  kimi: {
    "moonshotai/kimi-k2.5": {
      name: "Kimi K2.5",
      providerId: "kimi-k2.5",
      pricing: { input: 0.6, output: 3.0 },
      features: ["thinking", "web_search"],
    },
    "moonshotai/kimi-k2-thinking": {
      name: "Kimi K2 Thinking",
      providerId: "kimi-k2-thinking",
      pricing: { input: 0.6, output: 2.5 },
      features: [],
    },
  },
} as const satisfies Record<string, Record<string, ModelDefinition>>;

// ============================================================================
// Derived Types
// ============================================================================

/** All supported OpenRouter model identifiers */
export type SupportedModel = {
  [P in Provider]: keyof (typeof MODEL_REGISTRY)[P];
}[Provider] &
  string;

/** All provider-specific model identifiers */
type AnthropicModelId =
  (typeof MODEL_REGISTRY)["anthropic"][keyof (typeof MODEL_REGISTRY)["anthropic"]]["providerId"];
type GoogleModelId =
  (typeof MODEL_REGISTRY)["google"][keyof (typeof MODEL_REGISTRY)["google"]]["providerId"];
type QwenModelId =
  (typeof MODEL_REGISTRY)["qwen"][keyof (typeof MODEL_REGISTRY)["qwen"]]["providerId"];
type KimiModelId =
  (typeof MODEL_REGISTRY)["kimi"][keyof (typeof MODEL_REGISTRY)["kimi"]]["providerId"];
export type ProviderModelId =
  | AnthropicModelId
  | GoogleModelId
  | QwenModelId
  | KimiModelId;

// ============================================================================
// Derived Flat Maps (for fast lookups)
// ============================================================================

function buildFlatMap(): Map<string, ModelDefinition & { provider: Provider }> {
  const map = new Map<string, ModelDefinition & { provider: Provider }>();
  for (const [provider, models] of Object.entries(MODEL_REGISTRY)) {
    for (const [modelId, definition] of Object.entries(models)) {
      map.set(modelId, { ...definition, provider: provider as Provider });
    }
  }
  return map;
}

const flatModels = buildFlatMap();

// ============================================================================
// Lookup Helpers
// ============================================================================

/**
 * Get the full model definition by OpenRouter model ID.
 */
export function getModelDefinition(
  model: string
): (ModelDefinition & { provider: Provider }) | undefined {
  return flatModels.get(model);
}

/**
 * Check if a model identifier is supported (handles :thinking variant).
 */
export function isModelSupported(model: string): boolean {
  const base = model.endsWith(":thinking")
    ? model.slice(0, -":thinking".length)
    : model;
  const def = flatModels.get(base);
  if (!def) return false;
  if (model.endsWith(":thinking")) {
    return def.features.includes("thinking");
  }
  return true;
}

/**
 * Check if a model supports a specific feature.
 */
export function hasFeature(model: string, feature: ModelFeature): boolean {
  const def = flatModels.get(model);
  return def?.features.includes(feature) ?? false;
}

/**
 * Get the provider name for a model identifier.
 */
export function getProviderName(model: string): Provider | undefined {
  return flatModels.get(model)?.provider;
}

/**
 * Get the provider-specific model ID.
 */
export function getProviderModelId(model: string): string | undefined {
  return flatModels.get(model)?.providerId;
}

/**
 * Get pricing for a model (handles :thinking variant).
 */
export function getModelPricing(
  model: string
): { input: number; output: number } | undefined {
  const base = model.endsWith(":thinking")
    ? model.slice(0, -":thinking".length)
    : model;
  return flatModels.get(base)?.pricing;
}

/**
 * List of all supported model identifiers (including :thinking variants).
 */
export function getAllModelIds(): string[] {
  const ids: string[] = [];
  for (const [modelId, def] of flatModels) {
    ids.push(modelId);
    if (def.features.includes("thinking")) {
      ids.push(`${modelId}:thinking`);
    }
  }
  return ids;
}

/**
 * Get all model IDs as flat array (without variants).
 */
export function getBaseModelIds(): SupportedModel[] {
  return Array.from(flatModels.keys()) as SupportedModel[];
}
