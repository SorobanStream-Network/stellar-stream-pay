/**
 * Pre-flight validation for wallet-backed Soroban transactions.
 *
 * Every check here runs BEFORE the Freighter signing dialog is triggered, so
 * users are told *why* a transaction would fail instead of watching it get
 * rejected at the wallet or on-chain. Checks are intentionally cheap:
 *
 *  - wallet installed / connected / approved (no popup),
 *  - source account exists on the network,
 *  - native XLM balance covers gas,
 *  - sender token balance covers the locked amount (create),
 *  - receiver can actually receive the token (trustline probe, create).
 *
 * Anything these static checks can't see (stream state, exact fee, auth-entry
 * assembly) is caught by the transaction simulation that runs in the invoke
 * path — see `prepareTransaction` in `tx.ts`, which decodes simulation errors
 * with {@link decodeSorobanError} before Freighter is ever asked to sign.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { getAddress, isAllowed, isConnected } from "@stellar/freighter-api";
import { CONFIG } from "../../config";
import type { CreateStreamParams } from "../../types";
import { decodeSorobanError, PreflightError } from "./errors";
import { rpcServer } from "./rpc";

let horizon: Horizon.Server | null = null;

/** Lazily-created Horizon client for classic-account balance lookups. */
function horizonServer(): Horizon.Server {
  if (!horizon) horizon = new Horizon.Server(CONFIG.horizonUrl);
  return horizon;
}

/** A check that resolves to a blocking problem message, or `null` when it passes. */
type PreflightCheck = () => Promise<string | null>;

/**
 * Run every check, collect all failures, and throw a single {@link PreflightError}
 * listing them. Running all checks (rather than failing fast) lets users fix
 * several issues in one pass.
 */
export async function runPreflight(checks: PreflightCheck[]): Promise<void> {
  const problems: string[] = [];
  for (const check of checks) {
    const problem = await check();
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new PreflightError(
      "preflight",
      `Before continuing:\n• ${problems.join("\n• ")}`,
    );
  }
}

/**
 * Freighter is installed, connected, and approved for this dapp. Unlike
 * `connectWallet` this never triggers a popup — the wallet was already
 * connected to reach this screen.
 */
export async function assertFreighterReady(source?: string): Promise<string | null> {
  try {
    const connected = (await isConnected()) as {
      isConnected?: boolean;
      error?: unknown;
    };
    if (connected.error || !connected.isConnected) {
      return "Freighter is not installed or not connected. Install / unlock Freighter and connect your wallet first.";
    }
    const allowed = (await isAllowed()) as { isAllowed?: boolean; error?: unknown };
    if (allowed.error || !allowed.isAllowed) {
      return "Freighter access has not been granted for this app. Click “Connect Freighter” once to approve.";
    }
    if (source) {
      const addr = (await getAddress()) as { address?: string; error?: unknown };
      if (addr.error || !addr.address) {
        return "Freighter could not provide the active account.";
      }
      if (addr.address !== source) {
        return "The active Freighter account does not match the connected address. Switch accounts in Freighter and try again.";
      }
    }
    return null;
  } catch {
    return "Could not reach the Freighter extension. Is it installed and unlocked?";
  }
}

/**
 * The source account exists on the network (Soroban requires a funded source
 * account to exist before any transaction can be built against it).
 */
export async function assertAccountExists(address: string): Promise<string | null> {
  try {
    await rpcServer().getAccount(address);
    return null;
  } catch {
    return `The account ${address.slice(0, 8)}… has not been funded on this network. Fund it with XLM (e.g. Friendbot on Testnet) first.`;
  }
}

/** Native XLM balance of `address` as a decimal string (0 if none). */
export async function getNativeBalance(address: string): Promise<string> {
  try {
    const account = await horizonServer().loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === "native");
    return native?.balance ?? "0";
  } catch (err) {
    throw new PreflightError(
      "account",
      `Could not read the XLM balance for ${address.slice(0, 8)}… — ${decodeSorobanError(err)}`,
    );
  }
}

/**
 * The account holds at least `CONFIG.minGasXlm` XLM — a coarse gate against
 * sending users into a wallet dialog they can't afford. The exact fee comes
 * from the transaction simulation later.
 */
export async function assertSufficientGas(address: string): Promise<string | null> {
  try {
    const xlm = Number(await getNativeBalance(address));
    if (xlm < CONFIG.minGasXlm) {
      return `Not enough XLM for gas: you have ${xlm} XLM but at least ${CONFIG.minGasXlm} XLM is recommended for Soroban fees.`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Simulate a read-only contract call (no signing, no fee). Used for cheap
 * on-chain probes like `token.balance(addr)` and the trustline transfer probe.
 */
async function simulateContractCall(
  source: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  authMode: Api.SimulationAuthMode = "enforce",
): Promise<{ retval: xdr.ScVal | null; error: string | null }> {
  const server = rpcServer();
  const account = await server.getAccount(source);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx, undefined, authMode);
  if (Api.isSimulationError(sim)) {
    return { retval: null, error: sim.error ?? "Simulation failed." };
  }
  return { retval: sim.result?.retval ?? null, error: null };
}

/**
 * Read `holder`'s balance of `token` (SEP-41 `balance` view) via simulation.
 * Returns `null` balance when the call can't be simulated (wrong contract id,
 * archived token, unreachable network) with a decoded error.
 */
export async function getTokenBalance(
  token: string,
  holder: string,
): Promise<{ balance: bigint | null; error: string | null }> {
  try {
    const { retval, error } = await simulateContractCall(holder, token, "balance", [
      new Address(holder).toScVal(),
    ]);
    if (error || !retval) {
      return { balance: null, error: error ? decodeSorobanError(error) : null };
    }
    const value = scValToNative(retval);
    return { balance: typeof value === "bigint" ? value : BigInt(value), error: null };
  } catch (err) {
    return {
      balance: null,
      error: `Could not read the token contract: ${decodeSorobanError(err)}`,
    };
  }
}

/** The sender holds at least `amount` base units of `token`. */
export async function assertTokenBalance(
  token: string,
  holder: string,
  amount: string,
): Promise<string | null> {
  const { balance, error } = await getTokenBalance(token, holder);
  if (error) return error;
  if (balance === null) return "Could not read your token balance.";
  if (balance < BigInt(amount)) {
    return `Insufficient ${token.slice(0, 8)}… balance: you have ${balance} base units but need ${amount}.`;
  }
  return null;
}

/**
 * Probe whether `to` can receive `token` by simulating a 1-unit
 * `transfer(from → to)` in RECORD auth mode. The host executes the transfer as
 * if authorized (no signatures required), so a missing SAC trustline on the
 * receiver surfaces as a simulation error, which we decode. This is the
 * definitive trustline check: SAC has no "has trustline" view, and a `balance`
 * read returns 0 whether or not the trustline exists.
 *
 * The probe is intentionally conservative — it only BLOCKS on errors it can
 * attribute to the receiver (missing trustline / unfunded account). Any other
 * simulation failure (weird token semantics, network hiccup) passes through and
 * the real transaction simulation in the invoke path surfaces it precisely.
 */
export async function assertCanReceiveToken(
  token: string,
  from: string,
  to: string,
): Promise<string | null> {
  try {
    const server = rpcServer();
    const account = await server.getAccount(from);
    const contract = new Contract(token);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "transfer",
          new Address(from).toScVal(),
          new Address(to).toScVal(),
          nativeToScVal(1n, { type: "i128" }),
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx, undefined, "record");
    if (Api.isSimulationError(sim) && sim.error) {
      const raw = sim.error;
      if (/trustline|no trust|op_no_trust/i.test(raw)) {
        return "The receiver does not have a trustline for this token — they must add one in their wallet before receiving payments.";
      }
      if (/insufficient|underfunded|op_under|below.*min/i.test(raw)) {
        return "The receiver's account may not be able to hold this token yet (unfunded account or minimum-balance rule). Fund the receiver or add a trustline first.";
      }
      // Not definitively a receiver problem — let the real simulation decide.
    }
    return null;
  } catch {
    // Probe infrastructure failure — the real simulation will surface errors.
    return null;
  }
}

/** Full pre-flight for `create_stream`. Runs before the wallet dialog. */
export async function preflightCreateStream(
  params: CreateStreamParams,
): Promise<void> {
  await runPreflight([
    () => assertFreighterReady(params.sender),
    () => assertAccountExists(params.sender),
    () => assertSufficientGas(params.sender),
    // The sender must be able to lock the full amount…
    () => assertTokenBalance(params.token, params.sender, params.amount),
    // …and the receiver must be able to hold it (SAC trustline probe).
    () => assertCanReceiveToken(params.token, params.sender, params.receiver),
  ]);
}

/** Full pre-flight for `withdraw`. Runs before the wallet dialog. */
export async function preflightWithdraw(receiver: string): Promise<void> {
  await runPreflight([
    () => assertFreighterReady(receiver),
    () => assertAccountExists(receiver),
    () => assertSufficientGas(receiver),
  ]);
}

/** Full pre-flight for `cancel`. Runs before the wallet dialog. */
export async function preflightCancel(caller: string): Promise<void> {
  await runPreflight([
    () => assertFreighterReady(caller),
    () => assertAccountExists(caller),
    () => assertSufficientGas(caller),
  ]);
}
