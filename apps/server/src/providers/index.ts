/**
 * Provider Registry
 *
 * Factory module for selecting and instantiating LLM provider adapters
 * based on OpenRouter model identifiers. Derives all model data from
 * the central MODEL_REGISTRY.
 *
 * @module providers/index
 * @see Requirements 2.1, 2.2, 2.3, 2.4
 */

import {
  getAllModelIds,
  getModelDefinition,
  hasFeature,
  type ModelFeature,
  type Provider,
  getProviderModelId as registryGetProviderModelId,
  getProviderName as registryGetProviderName,
  isModelSupported as registryIsModelSupported,
  type SupportedModel,
} from "../models/registry.js";
import type { LLMProvider } from "./base.js";
import { UnsupportedModelError } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { GeminiProvider } from "./gemini.js";
import { KimiProvider } from "./kimi.js";
import { QwenProvider } from "./qwen.js";

// ============================================================================
// Re-exports from registry
// ============================================================================

export type { SupportedModel, Provider, ModelFeature };

export {
  getBaseModelIds,
  getModelDefinition,
  hasFeature,
  MODEL_REGISTRY,
  type ModelDefinition,
  type ProviderModelId,
} from "../models/registry.js";

// ============================================================================
// Model Capabilities (derived from registry features)
// ============================================================================

export interface ModelCapabilities {
  thinking: boolean;
  webSearch: boolean;
}

/**
 * Get capabilities for a model, derived from the registry features array.
 */
export function getModelCapabilities(
  model: string
): ModelCapabilities | undefined {
  const def = getModelDefinition(model);
  if (!def) return undefined;
  return {
    thinking: def.features.includes("thinking"),
    webSearch: def.features.includes("web_search"),
  };
}

// ============================================================================
// Model Variant Parsing
// ============================================================================

export interface ParsedModel {
  baseModel: SupportedModel;
  modelId: string;
  thinkingEnabled: boolean;
}

/**
 * List of all supported model identifiers (including :thinking variants) for error messages.
 */
export const SUPPORTED_MODEL_LIST: string[] = getAllModelIds();

/**
 * Parses a model string, stripping the :thinking variant suffix if present.
 * Validates the base model is supported and that the variant is allowed.
 *
 * @param model - Model identifier, optionally with :thinking suffix
 * @returns Parsed model info
 * @throws {UnsupportedModelError} If the model or variant is not supported
 */
export function parseModelVariant(model: string): ParsedModel {
  let baseModelKey = model;
  let thinkingEnabled = false;

  if (model.endsWith(":thinking")) {
    baseModelKey = model.slice(0, -":thinking".length);
    thinkingEnabled = true;
  }

  const modelId = registryGetProviderModelId(baseModelKey);
  if (!modelId) {
    throw new UnsupportedModelError(model, SUPPORTED_MODEL_LIST);
  }

  if (thinkingEnabled && !hasFeature(baseModelKey, "thinking")) {
    throw new UnsupportedModelError(model, SUPPORTED_MODEL_LIST);
  }

  return {
    baseModel: baseModelKey as SupportedModel,
    modelId,
    thinkingEnabled,
  };
}

// ============================================================================
// Provider Factory
// ============================================================================

export interface ProviderResult {
  provider: LLMProvider;
  modelId: string;
}

export class UnknownProviderError extends Error {
  public readonly model: string;

  constructor(model: string) {
    super(
      `Unknown provider for model '${model}'. This is an internal error - the model is in MODEL_REGISTRY but has no provider handler.`
    );
    this.name = "UnknownProviderError";
    this.model = model;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnknownProviderError);
    }
  }
}

/**
 * Factory function that returns the appropriate provider adapter based on
 * the OpenRouter model identifier.
 *
 * @param model - OpenRouter model identifier (e.g., 'anthropic/claude-sonnet-4.6')
 * @returns Object containing the provider instance and mapped model ID
 * @throws {UnsupportedModelError} If the model is not in MODEL_REGISTRY
 * @throws {UnknownProviderError} If the model prefix doesn't match any provider
 */
export function getProvider(model: string): ProviderResult {
  const modelId = registryGetProviderModelId(model);

  if (!modelId) {
    throw new UnsupportedModelError(model, SUPPORTED_MODEL_LIST);
  }

  const providerName = registryGetProviderName(model);

  if (providerName === "anthropic") {
    return { provider: new ClaudeProvider(), modelId };
  }

  if (providerName === "google") {
    return { provider: new GeminiProvider(), modelId };
  }

  if (providerName === "qwen") {
    return { provider: new QwenProvider(), modelId };
  }

  if (providerName === "kimi") {
    return { provider: new KimiProvider(), modelId };
  }

  throw new UnknownProviderError(model);
}

/**
 * Check if a model identifier is supported.
 */
export function isModelSupported(model: string): boolean {
  return registryIsModelSupported(model);
}

/**
 * Get the provider-specific model ID for a supported model.
 */
export function getProviderModelId(model: string): string | undefined {
  return registryGetProviderModelId(model);
}

/**
 * Get the provider name for a model identifier.
 */
export function getProviderName(
  model: string
): "anthropic" | "google" | "qwen" | "kimi" | undefined {
  return registryGetProviderName(model);
}
