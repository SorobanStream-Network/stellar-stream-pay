import { CONFIG } from "../../config";
import type { Stream } from "../../types";

/** Shape returned by the backend `/api/stream/:address` endpoint. */
type StreamsResponse = { streams?: Stream[] };

/**
 * Fetch every stream where `address` is the sender or receiver, decorated by
 * the backend indexer (`accrued`, `withdrawable`, `progress`, …).
 */
export async function getStreams(address: string): Promise<Stream[]> {
  const res = await fetch(`${CONFIG.backendUrl}/api/stream/${address}`);
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as StreamsResponse;
  return data.streams ?? [];
}
