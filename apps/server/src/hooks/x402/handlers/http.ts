/**
 * x402 HTTP Request Hooks
 *
 * Handlers for HTTP-level request processing before payment flow.
 * Requires JWT (SIWE) authentication. Grants access if user's debt
 * is below their threshold, otherwise triggers auto-payment.
 */

import { logger } from "@router402/utils";
import type { HTTPRequestContext, RouteConfig } from "@x402/core/server";
import { autoPayDebt } from "../../../services/auto-payment.js";
import { getUserDebt, isDebtBelowThreshold } from "../../../services/debt.js";
import {
  getJwtPayload,
  setWalletAddress,
} from "../../../utils/request-context.js";

const hookLogger = logger.context("x402:HTTP");

/**
 * Check debt threshold and grant access or trigger auto-payment.
 * Returns the hook result: grantAccess, abort, or undefined (continue to x402).
 */
async function checkDebtAndGrant(
  walletAddress: string,
  userId: string,
  chainId: number,
  path: string
): Promise<{ grantAccess: true } | undefined> {
  const belowThreshold = await isDebtBelowThreshold(walletAddress);

  if (belowThreshold) {
    setWalletAddress(walletAddress);
    hookLogger.info("Access granted - debt below threshold", {
      wallet: walletAddress.slice(0, 10),
      path,
    });
    return { grantAccess: true };
  }

  // Debt exceeds threshold - trigger auto-payment
  hookLogger.info("Debt exceeds threshold, triggering auto-payment", {
    wallet: walletAddress.slice(0, 10),
    path,
  });

  const debtAmount = await getUserDebt(walletAddress);
  const autoPayResult = await autoPayDebt(
    userId,
    walletAddress,
    chainId,
    debtAmount
  );

  if (autoPayResult.success) {
    setWalletAddress(walletAddress);
    hookLogger.info("Access granted - auto-payment successful", {
      wallet: walletAddress.slice(0, 10),
      txHash: autoPayResult.txHash,
      path,
    });
    return { grantAccess: true };
  }

  // Auto-payment failed - fallback to x402 payment flow
  hookLogger.warn("Auto-payment failed, falling back to payment flow", {
    wallet: walletAddress.slice(0, 10),
    error: autoPayResult.error,
    path,
  });
  return undefined;
}

/**
 * HTTP Protected Request Hook
 *
 * Runs on every request to a protected route before payment processing.
 * JWT authentication is handled by Express middleware (returns 401).
 * This hook reads the pre-validated JWT payload from request context
 * and handles debt checking / auto-payment logic.
 *
 * - Valid JWT + debt below threshold → grantAccess
 * - Valid JWT + debt above threshold → auto-pay, then grantAccess or fallback to x402
 */
export async function onProtectedRequest(
  context: HTTPRequestContext,
  _routeConfig: RouteConfig
): Promise<{ grantAccess: true } | undefined> {
  const path = context.path;
  const method = context.method;

  hookLogger.info("Hook started", { method, path });

  // JWT is already validated by Express middleware and stored in request context
  const jwtPayload = getJwtPayload();
  if (!jwtPayload) {
    // Should not happen — Express middleware rejects unauthenticated requests with 401
    hookLogger.warn("No JWT payload in request context", { path });
    return undefined;
  }

  const { walletAddress, userId, chainId } = jwtPayload;

  hookLogger.debug("JWT payload from context", {
    wallet: walletAddress.slice(0, 10),
    userId,
    chainId,
  });

  return checkDebtAndGrant(walletAddress, userId, chainId, path);
}
