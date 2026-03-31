/**
 * Nonce Service
 *
 * In-memory nonce store for SIWE authentication.
 * Each nonce is single-use and expires after a TTL.
 */

import { randomBytes } from "node:crypto";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const nonceStore = new Map<string, number>(); // nonce → expiresAt

/**
 * Generate a random nonce and store it with a TTL.
 */
export function generateNonce(): string {
  cleanup();
  const nonce = randomBytes(16).toString("hex");
  nonceStore.set(nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

/**
 * Consume a nonce. Returns true if it was valid and unused.
 * The nonce is deleted after consumption (single-use).
 */
export function consumeNonce(nonce: string): boolean {
  const expiresAt = nonceStore.get(nonce);
  if (!expiresAt) return false;

  nonceStore.delete(nonce);
  return Date.now() < expiresAt;
}

/**
 * Remove expired nonces.
 */
function cleanup(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonceStore) {
    if (now >= expiresAt) nonceStore.delete(nonce);
  }
}
