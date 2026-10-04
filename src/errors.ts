/**
 * The caller stopped waiting before the work finished. Not a failure: the
 * work behind it may still complete for whoever asks next.
 */
export class AbandonedError extends Error {
  override name = 'AbandonedError';
}

/** The requested source, file, rendition or segment does not exist. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** The file exists but cannot be served as HLS. */
export class UnsupportedMediaError extends Error {
  override name = 'UnsupportedMediaError';
}

/** The request waited longer than `requestTimeoutMs` for its result. */
export class MediaTimeoutError extends Error {
  override name = 'MediaTimeoutError';
}
