import { Server } from "@stellar/stellar-sdk/rpc";
import { CONFIG } from "../../config";

let server: Server | null = null;

/**
 * Lazily-created Soroban RPC client, shared across the app for the page's
 * lifetime. Cached because the RPC endpoint and allowHttp policy never change
 * at runtime.
 */
export function rpcServer(): Server {
  if (!server) {
    server = new Server(CONFIG.rpcUrl, {
      allowHttp: CONFIG.rpcUrl.startsWith("http://"),
    });
  }
  return server;
}
