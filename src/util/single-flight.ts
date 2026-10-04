import { AbandonedError } from '../errors.js';
import { untilAborted } from './async.js';

type PendingFlight = {
  promise: Promise<unknown>;
  abortController: AbortController;
  waiters: Set<AbortSignal>;
  onAborted?: () => void;
};
export class SingleFlight {
  private readonly pending = new Map<string, PendingFlight>();

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
    onAborted?: PendingFlight['onAborted'],
  ): Promise<T> {
    let flight = this.pending.get(key);
    if (!flight) {
      const created: PendingFlight = {
        promise: Promise.resolve()
          .then(task)
          .finally(() => {
            this.drop(key, created);
          }),
        abortController: new AbortController(),
        waiters: new Set(),
        onAborted,
      };
      this.pending.set(key, created);
      flight = created;
    }

    if (signal) {
      const { waiters } = flight;
      const current = flight;

      const leave = () => {
        waiters.delete(signal);

        if (waiters.size === 0) {
          this.drop(key, current, true);
        }
      };

      if (signal.aborted) {
        leave();
      } else {
        waiters.add(signal);

        const onComplete = () => {
          signal.removeEventListener('abort', leave);
        };
        signal.addEventListener('abort', leave, { once: true });
        flight.promise.then(onComplete, onComplete);
      }
    }

    return untilAborted(
      flight.promise,
      flight.abortController.signal,
    ) as Promise<T>;
  }

  keys(): MapIterator<string> {
    return this.pending.keys();
  }

  private drop(key: string, flight: PendingFlight, aborted = false) {
    if (this.pending.get(key) !== flight) {
      return;
    }

    if (aborted) {
      flight.abortController.abort(
        new AbandonedError(`No one is waiting for ${key}`),
      );
      flight.onAborted?.();
    }
    this.pending.delete(key);
  }
}
