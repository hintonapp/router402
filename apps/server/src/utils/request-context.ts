/**
 * Request Context using AsyncLocalStorage
 *
 * Allows sharing request-scoped data (like wallet address) across
 * different parts of the request lifecycle without passing through middleware.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface JwtPayloadContext {
  userId: string;
  walletAddress: string;
  chainId: number;
  sessionKeyId?: string;
}

interface RequestContext {
  walletAddress?: string;
  smartAccountAddress?: string;
  jwtPayload?: JwtPayloadContext;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current wallet address from request context
 */
export function getWalletAddress(): string | undefined {
  return requestContext.getStore()?.walletAddress;
}

/**
 * Set the wallet address in request context
 */
export function setWalletAddress(address: string): void {
  const store = requestContext.getStore();
  if (store) {
    // EVM addresses (0x-prefixed) are lowercased; Solana (Base58) kept as-is
    store.walletAddress = address.startsWith("0x")
      ? address.toLowerCase()
      : address;
  }
}

/**
 * Get the current smart account address from request context
 */
export function getSmartAccountAddressFromContext(): string | undefined {
  return requestContext.getStore()?.smartAccountAddress;
}

/**
 * Set the smart account address in request context
 */
export function setSmartAccountAddress(address: string): void {
  const store = requestContext.getStore();
  if (store) {
    store.smartAccountAddress = address.toLowerCase();
  }
}

/**
 * Get the JWT payload from request context
 */
export function getJwtPayload(): JwtPayloadContext | undefined {
  return requestContext.getStore()?.jwtPayload;
}

/**
 * Set the JWT payload in request context
 */
export function setJwtPayload(payload: JwtPayloadContext): void {
  const store = requestContext.getStore();
  if (store) {
    store.jwtPayload = payload;
  }
}
