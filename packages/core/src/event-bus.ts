import type { BugEvent } from "./types";

export class EventBus {
  private listeners: Array<(events: BugEvent[]) => void> = [];
  private taps: Array<(event: BugEvent) => void> = [];
  private buffer: BugEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private flushBufferSize = 100;
  private admissionPredicate: (event: BugEvent) => boolean = () => true;

  emit(event: BugEvent, options?: { bypassAdmission?: boolean }): void {
    if (!options?.bypassAdmission && !this.admissionPredicate(event)) return;
    for (const tap of this.taps) {
      try {
        tap(event);
      } catch {
        // A misbehaving tap must never break event capture.
      }
    }
    this.buffer.push(event);
    if (!this.paused && this.buffer.length >= this.flushBufferSize) {
      this.flush();
    }
  }

  /**
   * Observe every event synchronously at emit time, before batching. Unlike `subscribe`,
   * taps see events immediately (triggers can't wait out a flush interval) and never
   * receive batches.
   */
  tap(fn: (event: BugEvent) => void): () => void {
    this.taps.push(fn);
    return () => {
      const idx = this.taps.indexOf(fn);
      if (idx !== -1) this.taps.splice(idx, 1);
    };
  }

  subscribe(fn: (events: BugEvent[]) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Controls admission before taps, batches, subscribers, and the ring buffer see an event.
   * Privacy and capture policy use this boundary so denied events never rest locally.
   */
  setAdmissionPredicate(predicate: (event: BugEvent) => boolean): void {
    this.admissionPredicate = predicate;
  }

  /** Drop events that have not yet been flushed to subscribers. */
  clear(): void {
    this.buffer = [];
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const listener of this.listeners) {
      listener(batch);
    }
  }

  start(flushIntervalMs: number, flushBufferSize: number): void {
    this.flushBufferSize = flushBufferSize;
    this.flushTimer = setInterval(() => {
      if (!this.paused) this.flush();
    }, flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.flush();
  }
}
