import { Decimal } from "decimal.js";

/**
 * Pricing per million tokens for each supported model.
 * Prices are in USD.
 */
export const PRICING = {
  // Claude models
  "anthropic/claude-opus-4.6": { input: 5.0, output: 25.0 },
  "anthropic/claude-sonnet-4.6": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
  // Gemini models
  "google/gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "google/gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.5 },
} as const;

/**
 * Commission rate applied on top of base cost (10%)
 */
export const COMMISSION_RATE = new Decimal("0.10");

/**
 * Supported model identifiers for pricing
 */
export type SupportedModel = keyof typeof PRICING;

/**
 * Cost breakdown returned by calculateCost
 */
export interface CostBreakdown {
  /** Base cost before commission (input + output cost) */
  baseCost: Decimal;
  /** Commission amount (10% of base cost) */
  commission: Decimal;
  /** Total cost (base cost + commission) */
  totalCost: Decimal;
}

/**
 * Strips the :thinking variant suffix from a model identifier.
 */
function stripVariant(model: string): string {
  return model.endsWith(":thinking")
    ? model.slice(0, -":thinking".length)
    : model;
}

/**
 * Checks if a model is supported for pricing (handles :thinking variant)
 */
export function isSupportedModel(model: string): model is SupportedModel {
  return stripVariant(model) in PRICING;
}

/**
 * Calculates the cost for a given model and token usage.
 *
 * Uses Decimal.js for precise arithmetic to avoid floating-point errors.
 * Prices are per million tokens. Handles :thinking variant suffix.
 *
 * @param model - The model identifier (e.g., 'anthropic/claude-sonnet-4.6' or 'anthropic/claude-sonnet-4.6:thinking')
 * @param promptTokens - Number of input/prompt tokens
 * @param completionTokens - Number of output/completion tokens
 * @returns Cost breakdown with baseCost, commission, and totalCost
 * @throws Error if model is not supported
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): CostBreakdown {
  const baseModel = stripVariant(model);
  if (!(baseModel in PRICING)) {
    throw new Error(`Unsupported model for pricing: ${model}`);
  }

  const pricing = PRICING[baseModel as SupportedModel];

  // Calculate input cost: (promptTokens / 1,000,000) * inputPrice
  const inputCost = new Decimal(promptTokens).div(1_000_000).mul(pricing.input);

  // Calculate output cost: (completionTokens / 1,000,000) * outputPrice
  const outputCost = new Decimal(completionTokens)
    .div(1_000_000)
    .mul(pricing.output);

  // Base cost is input + output
  const baseCost = inputCost.plus(outputCost);

  // Commission is 10% of base cost
  const commission = baseCost.mul(COMMISSION_RATE);

  // Total cost is base + commission
  const totalCost = baseCost.plus(commission);

  return { baseCost, commission, totalCost };
}
