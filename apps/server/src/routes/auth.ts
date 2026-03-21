/**
 * SIWE Authentication Router
 *
 * GET  /v1/auth/nonce  — Generate a nonce for SIWE message signing
 * POST /v1/auth/verify — Verify a signed SIWE message and return a JWT
 */

import type { ApiResponse } from "@router402/types";
import { logger } from "@router402/utils";
import {
  Router as ExpressRouter,
  type Request,
  type Response,
  type Router,
} from "express";
import { verifyMessage } from "viem";
import { issueTokenForWallet } from "../services/auth.service.js";
import { consumeNonce, generateNonce } from "../services/nonce.js";

const authLogger = logger.context("AuthRouter:SIWE");

export const authRouter: Router = ExpressRouter();

/**
 * GET /nonce
 *
 * Returns a fresh nonce for the client to include in the SIWE message.
 */
authRouter.get("/nonce", (_req: Request, res: Response) => {
  const nonce = generateNonce();

  const response: ApiResponse<{ nonce: string }> = {
    data: { nonce },
    error: null,
    meta: { timestamp: new Date().toISOString(), path: "/v1/auth/nonce" },
  };

  return res.status(200).json(response);
});

// SIWE message line-based format (ERC-4361)
const SIWE_LINE_REGEX =
  /^(?<domain>.+) wants you to sign in with your Ethereum account:\n(?<address>0x[a-fA-F0-9]{40})\n/;

/**
 * Minimal SIWE message parser.
 * Extracts address, nonce, and chainId from the ERC-4361 text format.
 */
function parseSiweMessage(message: string): {
  address: string;
  nonce: string;
  chainId: number;
} | null {
  const addressMatch = SIWE_LINE_REGEX.exec(message);
  if (!addressMatch?.groups?.address) return null;

  const nonceMatch = /Nonce: (?<nonce>\S+)/.exec(message);
  if (!nonceMatch?.groups?.nonce) return null;

  const chainMatch = /Chain ID: (?<chainId>\d+)/.exec(message);
  if (!chainMatch?.groups?.chainId) return null;

  return {
    address: addressMatch.groups.address,
    nonce: nonceMatch.groups.nonce,
    chainId: parseInt(chainMatch.groups.chainId, 10),
  };
}

/**
 * POST /verify
 *
 * Body: { message: string, signature: string }
 *
 * Verifies the SIWE signature, validates the nonce, and returns a JWT.
 */
authRouter.post("/verify", async (req: Request, res: Response) => {
  try {
    const { message, signature } = req.body as {
      message?: string;
      signature?: string;
    };

    if (!message || !signature) {
      const errorResponse: ApiResponse = {
        data: null,
        error: "Missing message or signature",
        meta: { timestamp: new Date().toISOString(), path: req.path },
      };
      return res.status(400).json(errorResponse);
    }

    // 1. Parse the SIWE message
    const parsed = parseSiweMessage(message);
    if (!parsed) {
      authLogger.warn("Invalid SIWE message format");
      const errorResponse: ApiResponse = {
        data: null,
        error: "Invalid SIWE message format",
        meta: { timestamp: new Date().toISOString(), path: req.path },
      };
      return res.status(400).json(errorResponse);
    }

    // 2. Consume the nonce (single-use, checks expiry)
    if (!consumeNonce(parsed.nonce)) {
      authLogger.warn("Invalid or expired nonce", {
        nonce: parsed.nonce,
      });
      const errorResponse: ApiResponse = {
        data: null,
        error: "Invalid or expired nonce",
        meta: { timestamp: new Date().toISOString(), path: req.path },
      };
      return res.status(401).json(errorResponse);
    }

    // 3. Verify the signature against the message
    const isValid = await verifyMessage({
      address: parsed.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });

    if (!isValid) {
      authLogger.warn("SIWE signature verification failed", {
        wallet: parsed.address.slice(0, 10),
      });
      const errorResponse: ApiResponse = {
        data: null,
        error: "Invalid signature",
        meta: { timestamp: new Date().toISOString(), path: req.path },
      };
      return res.status(401).json(errorResponse);
    }

    // 4. Issue JWT
    const { token, userId } = await issueTokenForWallet(
      parsed.address,
      parsed.chainId
    );

    const successResponse: ApiResponse<{ token: string; userId: string }> = {
      data: { token, userId },
      error: null,
      meta: { timestamp: new Date().toISOString(), path: req.path },
    };

    authLogger.info("SIWE auth successful", {
      wallet: parsed.address.slice(0, 10),
      chainId: parsed.chainId,
    });

    return res.status(200).json(successResponse);
  } catch (error) {
    authLogger.error("SIWE verification error", { error });
    const errorResponse: ApiResponse = {
      data: null,
      error: "Internal server error",
      meta: { timestamp: new Date().toISOString(), path: req.path },
    };
    return res.status(500).json(errorResponse);
  }
});
