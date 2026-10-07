import type { RuntimeLogger } from "../../core/types.ts";
import type { ApprovalService } from "./approval-service.ts";

export interface ApprovalMaintenanceOptions {
  service: ApprovalService;
  logger?: RuntimeLogger;
}

/**
 * Periodic approval hygiene: expires lapsed pending records, releases stale
 * `executing` claims, purges terminal request ciphertext, and drops dead
 * grants. Node owns this timer; the Cloudflare scheduled handler calls
 * `ApprovalService.runMaintenance` directly instead.
 */
export class ApprovalMaintenance {
  private readonly options: ApprovalMaintenanceOptions;
  private readonly shutdown = new AbortController();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(options: ApprovalMaintenanceOptions) {
    this.options = options;
  }

  run(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    this.pending ??= this.options.service
      .runMaintenance()
      .catch((error) => {
        this.options.logger?.warn({ err: error }, "approval maintenance pass failed; work is retained");
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  start(): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    const tick = (): void => {
      void this.run().finally(() => {
        if (this.shutdown.signal.aborted) return;
        this.timer = setTimeout(tick, 60_000);
        this.timer.unref?.();
      });
    };
    tick();
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    clearTimeout(this.timer);
    await this.pending;
  }
}
