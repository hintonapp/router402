/**
 * Payment Signature Verification Utilities
 *
 * Verifies that payment signatures are signed by the claimed wallet address.
 * Supports both EVM (EIP-3009, Permit2) and Solana payment formats.
 */

import { logger } from "@router402/utils";
import type { PaymentRequirements } from "@x402/core/types";
import { verifyTypedData } from "viem";

const sigLogger = logger.context("signature");

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let result = "";
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    result = BASE58_ALPHABET[Number(remainder)] + result;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

/**
 * Read a compact-u16 encoded value from a buffer.
 * Returns [value, bytesConsumed].
 */
function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let bytesUsed = 0;
  for (let shift = 0; shift < 3; shift++) {
    const byte = buf[offset + bytesUsed];
    bytesUsed++;
    value |= (byte & 0x7f) << (shift * 7);
    if ((byte & 0x80) === 0) break;
  }
  return [value, bytesUsed];
}

/**
 * Extract the user's wallet (payer) from a serialized Solana transaction.
 *
 * In x402 Solana payments the transaction has at least 2 required signers:
 *   [0] = fee payer (facilitator)
 *   [1] = user (token owner / actual payer)
 *
 * If there is only 1 required signer, the fee payer IS the user.
 */
function extractSolanaPayerFromTx(txBase64: string): string | null {
  try {
    const buf = new Uint8Array(Buffer.from(txBase64, "base64"));
    let pos = 0;

    // Signatures: compact-u16 count + 64 bytes each
    const [sigCount, sigCountBytes] = readCompactU16(buf, pos);
    pos += sigCountBytes + sigCount * 64;

    // Detect versioned vs legacy: version prefix >= 0x80 means versioned
    const firstByte = buf[pos];
    if (firstByte >= 0x80) {
      pos++; // skip version byte
    }

    // Message header: 3 bytes
    const numRequiredSignatures = buf[pos];
    pos += 3; // skip header (numRequired, numReadonlySigned, numReadonlyUnsigned)

    // Static account keys: compact-u16 count + 32 bytes each
    const [keyCount, keyCountBytes] = readCompactU16(buf, pos);
    pos += keyCountBytes;

    if (keyCount === 0) return null;

    // The user is the second required signer (index 1) if there are >= 2 signers
    const targetIndex = numRequiredSignatures >= 2 && keyCount >= 2 ? 1 : 0;
    const keyStart = pos + targetIndex * 32;
    const keyBytes = buf.slice(keyStart, keyStart + 32);

    return base58Encode(keyBytes);
  } catch (error) {
    sigLogger.debug("Failed to extract Solana payer from transaction", {
      error,
    });
    return null;
  }
}

/**
 * Extracts wallet address from payment payload.
 * Supports EVM (EIP-3009, Permit2) and Solana (serialized transaction) formats.
 */
export function extractWalletFromPayload(
  payload: Record<string, unknown>
): string | null {
  // EIP-3009 format: payload.authorization.from
  if (payload.authorization) {
    const auth = payload.authorization as { from?: string };
    if (auth.from) {
      return auth.from.toLowerCase();
    }
  }

  // Permit2 format: payload.permit2Authorization.from
  if (payload.permit2Authorization) {
    const permit2 = payload.permit2Authorization as { from?: string };
    if (permit2.from) {
      return permit2.from.toLowerCase();
    }
  }

  // Solana format: payload.transaction (base64 serialized transaction)
  if (typeof payload.transaction === "string") {
    return extractSolanaPayerFromTx(payload.transaction);
  }

  return null;
}

// EIP-3009 typed data types
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Permit2 typed data types
const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface Permit2Authorization {
  from: string;
  permitted: { token: string; amount: string };
  spender: string;
  nonce: string;
  deadline: string;
  witness: { payTo: string; nonce: string };
}

/**
 * Verifies an EIP-3009 payment signature
 */
async function verifyEIP3009Signature(
  authorization: EIP3009Authorization,
  signature: string,
  walletAddress: string,
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  }
): Promise<boolean> {
  try {
    const isValid = await verifyTypedData({
      address: walletAddress as `0x${string}`,
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract as `0x${string}`,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });

    return isValid;
  } catch (error) {
    sigLogger.debug("EIP-3009 signature verification failed", { error });
    return false;
  }
}

/**
 * Verifies a Permit2 payment signature
 */
async function verifyPermit2Signature(
  authorization: Permit2Authorization,
  signature: string,
  walletAddress: string,
  chainId: number
): Promise<boolean> {
  const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

  try {
    const isValid = await verifyTypedData({
      address: walletAddress as `0x${string}`,
      domain: {
        name: "Permit2",
        chainId,
        verifyingContract: PERMIT2_ADDRESS,
      },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: {
          token: authorization.permitted.token as `0x${string}`,
          amount: BigInt(authorization.permitted.amount),
        },
        spender: authorization.spender as `0x${string}`,
        nonce: BigInt(authorization.nonce),
        deadline: BigInt(authorization.deadline),
        witness: {
          payTo: authorization.witness.payTo as `0x${string}`,
          nonce: authorization.witness.nonce as `0x${string}`,
        },
      },
      signature: signature as `0x${string}`,
    });

    return isValid;
  } catch (error) {
    sigLogger.debug("Permit2 signature verification failed", { error });
    return false;
  }
}

/**
 * Verifies that a payment signature was signed by the claimed wallet address.
 *
 * @param payload - The decoded payment payload (inner payload with authorization)
 * @param walletAddress - The claimed wallet address to verify against
 * @param accepted - The accepted payment requirements (contains domain info)
 * @returns true if signature is valid and matches the wallet address
 */
export async function verifyPaymentSignature(
  payload: Record<string, unknown>,
  walletAddress: string,
  accepted: PaymentRequirements
): Promise<boolean> {
  // Solana payments: signature is embedded in the serialized transaction.
  // Verification is handled by the facilitator during settlement.
  if (typeof payload.transaction === "string") {
    sigLogger.debug("Solana payment — skipping local signature verification");
    return true;
  }

  const signature = payload.signature as string | undefined;

  if (!signature) {
    sigLogger.debug("No signature in payload");
    return false;
  }

  // EIP-3009 format
  if (payload.authorization) {
    const auth = payload.authorization as EIP3009Authorization;

    // Domain info comes from accepted.extra
    const name = accepted.extra?.name as string | undefined;
    const version = accepted.extra?.version as string | undefined;

    if (!name || !version) {
      sigLogger.debug("No domain name/version in accepted requirements");
      return false;
    }

    // Extract chainId from network (e.g., "eip155:8453" -> 8453)
    const chainId = parseInt(accepted.network.split(":")[1], 10);

    const domain = {
      name,
      version,
      chainId,
      verifyingContract: accepted.asset,
    };

    return verifyEIP3009Signature(auth, signature, walletAddress, domain);
  }

  // Permit2 format
  if (payload.permit2Authorization) {
    const auth = payload.permit2Authorization as Permit2Authorization;

    // Extract chainId from network
    const chainId = parseInt(accepted.network.split(":")[1], 10);

    return verifyPermit2Signature(auth, signature, walletAddress, chainId);
  }

  sigLogger.debug("Unknown payload format");
  return false;
}
