import { Logger } from '@nestjs/common';

export class CircuitOpenError extends Error {
  constructor() {
    super('circuit is open');
  }
}

export interface BreakerOptions {
  /** Failure ratio, 0-1, at which the circuit trips. */
  threshold: number;
  /** Rolling window in ms over which the ratio is measured. */
  windowMs: number;
  /** How long the circuit stays open before a single probe is allowed through. */
  resetMs: number;
  /** Below this many calls in the window, the ratio is not meaningful. */
  minimumCalls: number;
}

/**
 * A circuit breaker around the Anthropic client.
 *
 * Without one, an upstream outage turns every resolve into an eight-second
 * timeout. At any real concurrency that exhausts the request pool and the
 * healthy routes — search, the repeat strip, committing a log — go down with
 * the dependency that actually failed. Open-circuit means the resolver returns
 * 503 immediately and the client falls back to search, which is the degradation
 * the flows were designed around.
 *
 * Hand-rolled rather than pulling in opossum: it is sixty lines, the semantics
 * are worth owning, and it is one fewer dependency in the hot path.
 */
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private readonly calls: Array<{ at: number; ok: boolean }> = [];
  private openedAt: number | null = null;
  /** Set while the single post-cooldown probe is in flight. */
  private probing = false;

  constructor(
    private readonly name: string,
    private readonly options: BreakerOptions,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt >= this.options.resetMs) {
      // Cooled down: allow exactly one probe through. If it succeeds the
      // circuit closes; if it fails the cooldown restarts.
      return this.probing;
    }
    return true;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) throw new CircuitOpenError();

    const isProbe = this.openedAt !== null;
    if (isProbe) this.probing = true;

    try {
      const result = await fn();
      this.record(true);
      if (isProbe) {
        this.logger.log({ breaker: this.name }, 'probe succeeded — circuit closed');
        this.close();
      }
      return result;
    } catch (error) {
      this.record(false);
      if (isProbe) {
        this.openedAt = Date.now(); // restart the cooldown
        this.probing = false;
      } else {
        this.evaluate();
      }
      throw error;
    }
  }

  private record(ok: boolean): void {
    const now = Date.now();
    this.calls.push({ at: now, ok });

    // Drop everything outside the rolling window.
    const cutoff = now - this.options.windowMs;
    while (this.calls.length > 0 && this.calls[0]!.at < cutoff) this.calls.shift();
  }

  private evaluate(): void {
    if (this.openedAt !== null) return;
    if (this.calls.length < this.options.minimumCalls) return;

    const failures = this.calls.filter((c) => !c.ok).length;
    const ratio = failures / this.calls.length;

    if (ratio >= this.options.threshold) {
      this.openedAt = Date.now();
      this.logger.warn(
        { breaker: this.name, ratio: Number(ratio.toFixed(2)), calls: this.calls.length },
        'circuit opened — failing fast to protect the request pool',
      );
    }
  }

  private close(): void {
    this.openedAt = null;
    this.probing = false;
    this.calls.length = 0;
  }

  /** Test seam. Production code never calls this. */
  reset(): void {
    this.close();
  }
}
