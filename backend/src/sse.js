/**
 * Server-Sent Events hub for live stream updates.
 *
 * The indexer folds events from Soroban RPC every few seconds; the hub pushes
 * each newly folded event to every connected browser so the dashboard updates
 * without polling. SSE (not WebSockets) because the data is strictly
 * server-to-client, survives proxies as plain HTTP, and reconnects itself via
 * the browser's `EventSource`.
 *
 * Frames use the standard wire format:
 *   event: stream            <- the event kind is carried inside the JSON
 *   data: {"kind":"created"...}
 *   (blank line)
 * and an empty comment line every `heartbeatMs` keeps idle connections (and
 * intermediary timeouts) alive.
 */
export function createEventHub({ heartbeatMs = 20_000 } = {}) {
  /** @type {Set<{ res: import("node:http").ServerResponse, address: string | null }>} */
  const clients = new Set();

  const write = (res, chunk) => {
    try {
      res.write(chunk);
    } catch {
      // Socket already gone; the `close` handler removes the client.
    }
  };

  /**
   * Attach an SSE response. `address` (optional) filters the feed to events
   * where that account is the sender or receiver.
   */
  function subscribe(res, { address = null, hello = {} } = {}) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering (nginx) so events arrive immediately.
      "x-accel-buffering": "no",
    });
    write(res, "retry: 3000\n\n");
    write(res, `event: hello\ndata: ${JSON.stringify(hello)}\n\n`);

    const client = { res, address };
    clients.add(client);
    res.on("close", () => clients.delete(client));
    res.on("error", () => clients.delete(client));
    return client;
  }

  /** Push one decoded event to matching subscribers. */
  function broadcast(event) {
    if (clients.size === 0) return 0;
    const data = `event: stream\ndata: ${JSON.stringify(event)}\n\n`;
    let sent = 0;
    for (const client of clients) {
      if (
        client.address &&
        event.sender !== client.address &&
        event.receiver !== client.address
      ) {
        continue;
      }
      write(client.res, data);
      sent += 1;
    }
    return sent;
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) write(client.res, ": ping\n\n");
  }, heartbeatMs);
  // Never keep the process alive just for the heartbeat.
  heartbeat.unref?.();

  function close() {
    clearInterval(heartbeat);
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        /* already closed */
      }
    }
    clients.clear();
  }

  return {
    subscribe,
    broadcast,
    close,
    get size() {
      return clients.size;
    },
  };
}
