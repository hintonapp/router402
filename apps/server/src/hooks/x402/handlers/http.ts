/**
 * x402 HTTP Request Hooks
 *
 * Handlers for HTTP-level request processing before payment flow.
 * Requires JWT (SIWE) authentication. Grants access if user's debt
 * is below their threshold, otherwise triggers auto-payment.
 */

import { logger } from "@router402/utils";
import type { HTTPRequestContext, RouteConfig } from "@x402/core/server";
import { verifyToken } from "../../../services/auth.service.js";
import { autoPayDebt } from "../../../services/auto-payment.js";
import { getUserDebt, isDebtBelowThreshold } from "../../../services/debt.js";
import { setWalletAddress } from "../../../utils/request-context.js";

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
 * Requires a valid JWT (SIWE) token in the Authorization header.
 *
 * - Valid JWT + debt below threshold → grantAccess
 * - Valid JWT + debt above threshold → auto-pay, then grantAccess or fallback to x402
 * - Invalid/missing JWT → 403
 */
export async function onProtectedRequest(
  context: HTTPRequestContext,
  _routeConfig: RouteConfig
): Promise<
  { grantAccess: true } | { abort: true; reason: string } | undefined
> {
  const path = context.path;
  const method = context.method;
  const authHeader = context.adapter.getHeader("authorization");

  hookLogger.info("Hook started", { method, path });

  // Require JWT Bearer token
  if (!authHeader?.startsWith("Bearer ")) {
    hookLogger.warn("No JWT token provided", { path });
    return {
      abort: true,
      reason: "Authentication required. Provide a valid JWT token.",
    };
  }

  const token = authHeader.slice(7);
  const jwtPayload = verifyToken(token);

  if (!jwtPayload) {
    hookLogger.warn("Invalid JWT token", { path });
    return {
      abort: true,
      reason: "Invalid or expired JWT token.",
    };
  }

  const { walletAddress, userId, chainId } = jwtPayload;

  hookLogger.debug("JWT validated", {
    wallet: walletAddress.slice(0, 10),
    userId,
    chainId,
  });

  return checkDebtAndGrant(walletAddress, userId, chainId, path);
}
