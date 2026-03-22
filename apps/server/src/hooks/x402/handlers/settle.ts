/**
 * x402 Settlement Hooks
 *
 * Handlers for payment settlement lifecycle events.
 * These hooks run during the settlement phase of the x402 payment flow.
 */

import { logger } from "@router402/utils";
import { processPayment } from "../../../services/debt.js";
import { getWalletAddress } from "../../../utils/request-context.js";

const hookLogger = logger.context("x402:Settle");

/**
 * Known facilitator placeholder payer values that should not be stored.
 */
const PLACEHOLDER_PAYERS = new Set(["solana-payer", "stacks-payer", "unknown"]);

/**
 * Runs before payment settlement
 * Use to perform final checks before committing the transaction
 *
 * @returns AbortResult to reject, undefined to continue
 */
export async function onBeforeSettle(context: {
  requirements: { network: string; amount: string };
}): Promise<{ abort: true; reason: string } | undefined> {
  hookLogger.debug("Before settle", {
    network: context.requirements.network,
    amount: context.requirements.amount,
  });

  return undefined;
}

/**
 * Runs after successful payment settlement
 * Creates Payment record, marks UsageRecords as paid, reduces currentDebt
 */
export async function onAfterSettle(context: {
  result: { success?: boolean; payer?: string; transaction?: string };
  requirements: { network: string; amount: string };
}): Promise<void> {
  // The x402 library calls afterSettleHooks regardless of settlement success.
  // The facilitator returns { success: false } (without throwing) on failures
  // like insufficient funds, so we must check before processing.
  if (context.result.success === false) {
    hookLogger.warn("Settlement was not successful, skipping debt update", {
      network: context.requirements.network,
      amount: context.requirements.amount,
    });
    return;
  }

  const facilitatorPayer = context.result.payer;
  const txHash = context.result.transaction;
  const rawAmount = context.requirements.amount;
  // requirements.amount is in token smallest units (micro-USDC, 6 decimals)
  // Convert to dollars for debt tracking
  const amount = (Number(rawAmount) / 1e6).toString();

  // Use the wallet extracted during request processing (from payment payload).
  // Fall back to the facilitator's payer only if it's a real address.
  const contextWallet = getWalletAddress();
  const payer =
    contextWallet ??
    (facilitatorPayer && !PLACEHOLDER_PAYERS.has(facilitatorPayer)
      ? facilitatorPayer
      : null);

  hookLogger.info("Payment settled", {
    payer: payer ?? "unknown",
    facilitatorPayer: facilitatorPayer ?? "unknown",
    transaction: txHash ?? "unknown",
    network: context.requirements.network,
    amount,
  });

  if (payer) {
    try {
      await processPayment(payer, amount, txHash);
    } catch (error) {
      hookLogger.error("Failed to process payment", {
        payer: payer.slice(0, 10),
        error,
      });
    }
  } else {
    hookLogger.warn("No real payer address available, skipping DB update", {
      facilitatorPayer,
      network: context.requirements.network,
    });
  }
}

/**
 * Runs when settlement fails
 * Use to implement recovery logic or notify administrators
 */
export async function onSettleFailure(context: {
  error: Error;
  requirements: { network: string; amount: string };
}): Promise<void> {
  hookLogger.error("Settlement failed", {
    error: context.error?.message,
    network: context.requirements.network,
    amount: context.requirements.amount,
  });
}
