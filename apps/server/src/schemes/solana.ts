import type { x402ResourceServer } from "@x402/core/server";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";

/**
 * Solana USDC stablecoin addresses per CAIP-2 network
 */
const SOLANA_STABLECOINS: Record<
  string,
  { address: string; name: string; decimals: number }
> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    name: "USD Coin",
    decimals: 6,
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    name: "USDC",
    decimals: 6,
  },
};

/**
 * Exact payment scheme for Solana networks.
 * Mirrors ExactEvmScheme from @x402/evm but with Solana USDC addresses.
 */
export class ExactSolanaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(
          `Asset address must be specified for AssetAmount on network ${network}`
        );
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const amount = this.parseMoneyToDecimal(price);
    return this.defaultMoneyConversion(amount, network);
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _facilitatorExtensions: string[]
  ): Promise<PaymentRequirements> {
    return paymentRequirements;
  }

  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }
    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = Number.parseFloat(cleanMoney);
    if (Number.isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }
    return amount;
  }

  private defaultMoneyConversion(amount: number, network: string): AssetAmount {
    const assetInfo = SOLANA_STABLECOINS[network];
    if (!assetInfo) {
      throw new Error(
        `No default asset configured for Solana network ${network}`
      );
    }

    const tokenAmount = this.convertToTokenAmount(
      amount.toString(),
      assetInfo.decimals
    );
    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: { name: assetInfo.name },
    };
  }

  private convertToTokenAmount(
    decimalAmount: string,
    decimals: number
  ): string {
    const amount = Number.parseFloat(decimalAmount);
    if (Number.isNaN(amount)) {
      throw new Error(`Invalid amount: ${decimalAmount}`);
    }
    const [intPart, decPart = ""] = String(amount).split(".");
    const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
    const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
    return tokenAmount;
  }
}

/**
 * Register the exact Solana scheme with the x402 resource server.
 */
export function registerExactSolanaScheme(
  server: x402ResourceServer
): x402ResourceServer {
  server.register("solana:*" as Network, new ExactSolanaScheme());
  return server;
}
