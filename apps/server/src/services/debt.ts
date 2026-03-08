/**
 * Debt Service
 *
 * Manages user debt checks against configured threshold.
 */

import { logger } from "@router402/utils";
import { Decimal } from "decimal.js";
import { PrismaClient } from "../../generated/prisma/client.js";

const debtLogger = logger.context("DebtService");

let prisma: PrismaClient | null = null;

/**
 * Initialize the debt service with Prisma client
 */
export function initDebtService(client: PrismaClient): void {
  prisma = client;
  debtLogger.info("Debt service initialized");
}

/**
 * Get Prisma client or throw if not initialized
 */
function getPrisma(): PrismaClient {
  if (!prisma) {
    throw new Error(
      "Debt service not initialized. Call initDebtService first."
    );
  }
  return prisma;
}

/**
 * Get or create user by wallet address
 */
/**
 * Normalize wallet address for storage.
 * EVM addresses (0x-prefixed) are lowercased.
 * Solana addresses (Base58) are stored as-is since they are case-sensitive.
 */
function normalizeWalletAddress(address: string): string {
  if (address.startsWith("0x")) {
    return address.toLowerCase();
  }
  return address;
}

export async function getOrCreateUser(walletAddress: string) {
  const db = getPrisma();
  const normalizedAddress = normalizeWalletAddress(walletAddress);

  const user = await db.user.upsert({
    where: { walletAddress: normalizedAddress },
    update: {},
    create: {
      walletAddress: normalizedAddress,
      // currentDebt, totalSpent, and paymentThreshold use Prisma schema defaults
    },
  });

  debtLogger.debug("User retrieved/created", {
    wallet: normalizedAddress.slice(0, 10),
    id: user.id,
  });

  return user;
}

/**
 * Get user's current debt as number (in dollars)
 */
export async function getUserDebt(walletAddress: string): Promise<number> {
  try {
    const user = await getOrCreateUser(walletAddress);
    return new Decimal(user.currentDebt).toNumber();
  } catch (error) {
    debtLogger.error("Failed to get user debt", {
      wallet: walletAddress.slice(0, 10),
      error,
    });
    return 0;
  }
}

/**
 * Check if user's debt is below their personal threshold
 */
export async function isDebtBelowThreshold(
  walletAddress: string
): Promise<boolean> {
  try {
    const user = await getOrCreateUser(walletAddress);

    const debt = new Decimal(user.currentDebt);
    const threshold = new Decimal(user.paymentThreshold);
    const belowThreshold = debt.lessThan(threshold);

    debtLogger.debug("Debt threshold check", {
      wallet: walletAddress.slice(0, 10),
      debt: debt.toString(),
      threshold: threshold.toString(),
      belowThreshold,
    });

    return belowThreshold;
  } catch (error) {
    debtLogger.error("Failed to check debt threshold", {
      wallet: walletAddress.slice(0, 10),
      error,
    });
    // On error, don't grant access - require payment
    return false;
  }
}

/**
 * Add to user's debt (amount in dollars)
 */
export async function addUserDebt(
  walletAddress: string,
  amount: number
): Promise<void> {
  const db = getPrisma();
  const user = await getOrCreateUser(walletAddress);
  const amountDecimal = new Decimal(amount);

  await db.user.update({
    where: { id: user.id },
    data: {
      currentDebt: { increment: amountDecimal },
      totalSpent: { increment: amountDecimal },
    },
  });

  debtLogger.info("User debt added", {
    wallet: walletAddress.slice(0, 10),
    added: amount,
  });
}

/**
 * Reset user's debt to zero (after payment)
 */
export async function resetUserDebt(walletAddress: string): Promise<void> {
  const db = getPrisma();
  const user = await getOrCreateUser(walletAddress);

  await db.user.update({
    where: { id: user.id },
    data: { currentDebt: new Decimal(0) },
  });

  debtLogger.info("User debt reset", { wallet: walletAddress.slice(0, 10) });
}

/**
 * Record usage for a user
 */
export async function recordUsage(
  walletAddress: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  baseCost: number,
  commission: number,
  totalCost: number
): Promise<void> {
  const db = getPrisma();
  const user = await getOrCreateUser(walletAddress);

  await db.usageRecord.create({
    data: {
      userId: user.id,
      model,
      promptTokens,
      completionTokens,
      baseCost: new Decimal(baseCost),
      commission: new Decimal(commission),
      totalCost: new Decimal(totalCost),
      isPaid: false,
    },
  });

  // Also increment user's debt
  await db.user.update({
    where: { id: user.id },
    data: {
      currentDebt: { increment: new Decimal(totalCost) },
      totalSpent: { increment: new Decimal(totalCost) },
    },
  });

  debtLogger.info("Usage recorded", {
    wallet: walletAddress.slice(0, 10),
    model,
    totalCost,
  });
}

/**
 * Process a payment settlement
 * Creates a Payment record, marks unpaid UsageRecords as paid, and reduces currentDebt
 */
export async function processPayment(
  walletAddress: string,
  amount: string,
  txHash?: string
): Promise<void> {
  const db = getPrisma();
  const user = await getOrCreateUser(walletAddress);
  const paymentAmount = new Decimal(amount.replace("$", ""));

  // Create payment and update records in a transaction
  await db.$transaction(async (tx) => {
    // Create the payment record
    const payment = await tx.payment.create({
      data: {
        userId: user.id,
        amount: paymentAmount,
        txHash: txHash || null,
        status: "SETTLED",
        settledAt: new Date(),
      },
    });

    // Get all unpaid usage records for this user (snapshot their IDs)
    const unpaidRecords = await tx.usageRecord.findMany({
      where: {
        userId: user.id,
        isPaid: false,
      },
      orderBy: { createdAt: "asc" },
    });

    // Use explicit IDs to avoid marking records created by concurrent requests
    // that were not counted in totalUnpaid (race condition fix)
    const unpaidIds = unpaidRecords.map((r) => r.id);

    // Calculate total unpaid amount
    const totalUnpaid = unpaidRecords.reduce(
      (sum, record) => sum.plus(new Decimal(record.totalCost)),
      new Decimal(0)
    );

    // Mark ONLY the records we counted as paid (by ID, not by isPaid flag)
    if (unpaidIds.length > 0) {
      await tx.usageRecord.updateMany({
        where: {
          id: { in: unpaidIds },
        },
        data: {
          isPaid: true,
          paymentId: payment.id,
        },
      });
    }

    // Recalculate currentDebt from remaining unpaid records to self-heal any
    // existing drift (phantom debt) instead of using decrement
    const remainingUnpaid = await tx.usageRecord.findMany({
      where: {
        userId: user.id,
        isPaid: false,
      },
      select: { totalCost: true },
    });

    const newDebt = remainingUnpaid.reduce(
      (sum, record) => sum.plus(new Decimal(record.totalCost)),
      new Decimal(0)
    );

    await tx.user.update({
      where: { id: user.id },
      data: {
        currentDebt: newDebt,
      },
    });

    debtLogger.info("Payment processed", {
      wallet: walletAddress.slice(0, 10),
      paymentId: payment.id,
      amount: paymentAmount.toString(),
      recordsMarkedPaid: unpaidIds.length,
      previousUnpaid: totalUnpaid.toString(),
      newDebt: newDebt.toString(),
    });
  });
}
