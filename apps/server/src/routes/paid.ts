import { logger } from "@router402/utils";
// x402 imports from npm packages
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext } from "@x402/core/server";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  Router as ExpressRouter,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { getChainConfig, getSolanaNetworkConfig } from "../config/chain.js";
import type { Config } from "../config/index.js";
import { registerX402Hooks, registerX402HTTPHooks } from "../hooks/index.js";
import { registerExactSolanaScheme } from "../schemes/solana.js";
import { getUserDebt } from "../services/debt.js";
import { requestContext } from "../utils/request-context.js";
import { extractWalletFromPayload } from "../utils/signature.js";
import { createChatRouter } from "./chat.js";

const routeLogger = logger.context("x402:Routes");

/**
 * Dynamic price function that returns user's current debt
 */
/**
 * Dynamic price function that returns user's current debt
 * Returns "0" when no payment header (JWT auth case - access already granted by hook)
 */
async function getDynamicPrice(context: HTTPRequestContext): Promise<string> {
  // Try payment header first, then fall back to Wallet-Address header
  let wallet: string | null = null;

  const paymentHeader = context.paymentHeader;
  if (paymentHeader) {
    const payload = decodePaymentSignatureHeader(paymentHeader);
    const innerPayload = payload.payload as Record<string, unknown>;
    wallet = extractWalletFromPayload(innerPayload);
  }

  if (!wallet) {
    wallet = context.adapter.getHeader("wallet-address") ?? null;
  }

  if (!wallet) {
    routeLogger.info("getDynamicPrice: no wallet available → price $0");
    return "0";
  }

  const debt = await getUserDebt(wallet);
  const priceString = `${debt.toFixed(8)}`;
  routeLogger.info("getDynamicPrice", {
    wallet: wallet.slice(0, 10),
    debtDollars: debt,
    priceString,
  });
  return priceString;
}

export function createPaidRouter(config: Config): Router {
  const paidRouter: Router = ExpressRouter();
  const payTo = config.PAY_TO;
  const payToSolana = config.PAY_TO_SOLANA;
  const { network } = getChainConfig();
  const { network: solanaNetwork } = getSolanaNetworkConfig();

  // Create facilitator client
  const facilitatorClient = new HTTPFacilitatorClient({
    url: config.FACILITATOR_URL,
  });

  // Create resource server and register EVM + Solana schemes
  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(resourceServer);
  registerExactSolanaScheme(resourceServer);

  // Register lifecycle hooks (verify, settle)
  registerX402Hooks(resourceServer);

  // Define routes configuration
  const routes = {
    "GET /debt": {
      accepts: [
        {
          scheme: "exact",
          price: getDynamicPrice,
          network: network as "eip155:8453" | "eip155:84532",
          payTo,
        },
        {
          scheme: "exact",
          price: getDynamicPrice,
          network: solanaNetwork as `solana:${string}`,
          payTo: payToSolana,
        },
      ],
      description: "Access to protected content",
      mimeType: "application/json",
    },
    "POST /chat/completions": {
      accepts: [
        {
          scheme: "exact",
          price: getDynamicPrice,
          network: network as "eip155:8453" | "eip155:84532",
          payTo,
        },
        {
          scheme: "exact",
          price: getDynamicPrice,
          network: solanaNetwork as `solana:${string}`,
          payTo: payToSolana,
        },
      ],
      description: "OpenRouter-compatible LLM chat completions",
      mimeType: "application/json",
    },
  };

  // Create HTTP resource server with routes
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // Register HTTP-level hooks (onProtectedRequest for API key bypass, subscription check, etc.)
  registerX402HTTPHooks(httpServer);

  routeLogger.info("x402 HTTP Resource Server configured with hooks");

  // Get the payment middleware and wrap it for Express compatibility
  const x402Middleware = paymentMiddlewareFromHTTPServer(httpServer);

  // Apply payment middleware to all routes in this router
  paidRouter.use((req: Request, res: Response, next: NextFunction) => {
    // Run the rest of the request in an async context for wallet tracking
    requestContext.run({ walletAddress: undefined }, () => {
      // Intercept response to log x402 middleware decisions
      const originalWriteHead = res.writeHead.bind(res);
      // biome-ignore lint/suspicious/noExplicitAny: Express writeHead overloads
      res.writeHead = (statusCode: number, ...args: any[]) => {
        if (statusCode === 402) {
          const paymentRequired = res.getHeader("PAYMENT-REQUIRED");
          routeLogger.info("x402 middleware → 402 Payment Required", {
            path: req.path,
            method: req.method,
            hasPaymentRequiredHeader: !!paymentRequired,
          });
        } else if (statusCode === 403) {
          routeLogger.info("x402 middleware → 403 Forbidden", {
            path: req.path,
          });
        }
        return originalWriteHead(statusCode, ...args);
      };

      // biome-ignore lint/suspicious/noExplicitAny: Express types version mismatch between project and x402 submodule
      x402Middleware(req as any, res as any, (...nextArgs: unknown[]) => {
        routeLogger.info("x402 middleware → next() (access granted)", {
          path: req.path,
          method: req.method,
        });
        next(...(nextArgs as []));
      });
    });
  });

  // Protected endpoint
  paidRouter.get("/protected", (_req, res) => {
    res.json({
      message: "This content is behind a paywall",
      timestamp: new Date().toISOString(),
    });
  });

  // Mount chat router for OpenRouter-compatible LLM chat completions
  paidRouter.use("/", createChatRouter());

  return paidRouter;
}
