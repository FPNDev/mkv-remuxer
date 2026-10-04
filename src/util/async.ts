/**
 * Rejects with onTimeout() after timeoutMs. The promise keeps running, so a
 * caller holding a process or a stream still has to tear it down.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts. */
export function untilAborted(promise: Promise<unknown>, signal?: AbortSignal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  const { resolve, reject, promise: resultPromise } = Promise.withResolvers();
  const onAbort = () => {
    reject(signal.reason);
  };

  signal.addEventListener('abort', onAbort, { once: true });
  void promise.then((res) => {
    signal.removeEventListener('abort', onAbort);
    resolve(res);
  }, reject);

  return resultPromise;
}
