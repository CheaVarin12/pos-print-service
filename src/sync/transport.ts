/**
 * Where new tasks come from.
 *
 * Today: polling (Poller) every 2-3 seconds. Polling is also the ONLY place that claims tasks and
 * renews leases, so it stays the source of truth.
 *
 * Later (optional): a WebSocket (e.g. Laravel Reverb) can call `triggerNow()` when the server says
 * "new task for your branch". The task then prints at once instead of waiting for the next poll,
 * and polling keeps running as the backup if the WebSocket drops.
 */
export interface TaskFeed {
  start(): void;
  stop(): Promise<void>;
  /** Sync now instead of waiting for the next interval. */
  triggerNow(): void;
}
