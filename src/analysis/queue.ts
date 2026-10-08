export type QueueWorker = (feedbackId: string) => Promise<void>;

/**
 * In-process FIFO with a concurrency cap. It holds only ids and is not the
 * source of truth: anything lost here is still RECEIVED in the database and
 * is re-enqueued on the next startup.
 */
export class AnalysisQueue {
  private readonly worker: QueueWorker;
  private readonly concurrency: number;
  private readonly onError: (feedbackId: string, err: unknown) => void;
  private readonly pending: string[] = [];
  private active = 0;
  private stopped = false;
  private idleWaiters: (() => void)[] = [];

  constructor(worker: QueueWorker, concurrency: number, onError: (feedbackId: string, err: unknown) => void) {
    this.worker = worker;
    this.concurrency = concurrency;
    this.onError = onError;
  }

  enqueue(feedbackId: string): void {
    if (this.stopped) return;
    this.pending.push(feedbackId);
    this.pump();
  }

  /** Drops queued work and stops accepting more; in-flight jobs run to completion. */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.resolveIfIdle();
  }

  /** Resolves once nothing is queued or running. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.active === 0 && this.pending.length === 0;
  }

  private resolveIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const feedbackId = this.pending.shift()!;
      this.active++;
      this.worker(feedbackId)
        .catch((err) => this.onError(feedbackId, err))
        .finally(() => {
          this.active--;
          this.pump();
          this.resolveIfIdle();
        });
    }
  }
}
