/**
 * Error thrown for wallet and transaction failures that should be surfaced to
 * the user (installation missing, access denied, rejected/failed transaction).
 */
export class WalletError extends Error {}
