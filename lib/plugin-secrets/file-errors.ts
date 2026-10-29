/** Public error codes contain no native paths, credentials or upstream diagnostics. */
export class FileResourceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 | 413 | 503 | 504) {
    super(code);
  }
}
