import { logger } from "./logger.js";

export class Heartbeat {
  probe: () => Promise<string>;
  intervalMs: number;
  log: Pick<typeof logger, "info" | "warn">;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;

  constructor(
    probe: () => Promise<string>,
    {
      intervalMs = 60_000,
      log = logger,
    }: { intervalMs?: number; log?: Pick<typeof logger, "info" | "warn"> } = {},
  ) {
    this.probe = probe;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.inFlight = null;
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  async check() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        this.log.info(`Heartbeat: ${await this.probe()}`);
      } catch (error) {
        this.log.warn(
          `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
