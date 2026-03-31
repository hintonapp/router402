import { Decimal } from "decimal.js";
import {
  getModelPricing,
  isModelSupported as registryIsModelSupported,
  type SupportedModel,
} from "../models/registry.js";

export type { SupportedModel };

/**
 * Commission rate applied on top of base cost (10%)
 */
export const COMMISSION_RATE = new Decimal("0.10");

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
 * Checks if a model is supported for pricing (handles :thinking variant)
 */
export function isSupportedModel(model: string): model is SupportedModel {
  return registryIsModelSupported(model);
}

/**
 * Calculates the cost for a given model and token usage.
 *
 * Uses Decimal.js for precise arithmetic to avoid floating-point errors.
 * Prices are per million tokens. Handles :thinking variant suffix.
 *
 * @param model - The model identifier (e.g., 'anthropic/claude-sonnet-4.6')
 * @param promptTokens - Number of input/prompt tokens
 * @param completionTokens - Number of output/completion tokens
 * @returns Cost breakdown with baseCost, commission, and totalCost
 * @throws Error if model is not supported
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): CostBreakdown {
  const pricing = getModelPricing(model);

  if (!pricing) {
    throw new Error(`Unsupported model for pricing: ${model}`);
  }

  const inputCost = new Decimal(promptTokens).div(1_000_000).mul(pricing.input);

  const outputCost = new Decimal(completionTokens)
    .div(1_000_000)
    .mul(pricing.output);

  const baseCost = inputCost.plus(outputCost);
  const commission = baseCost.mul(COMMISSION_RATE);
  const totalCost = baseCost.plus(commission);

  return { baseCost, commission, totalCost };
}
