/**
 * The PDF upload cap, as the server reports it.
 *
 * The cap is UPLOAD_MAX_MB in the backend's .env, and the backend serves the
 * number its upload middleware was actually built with on GET /api/auth/me,
 * which AuthContext already fetches once for every page. It is deliberately
 * not a NEXT_PUBLIC_ variable: that would be compiled into the bundle at build
 * time and could disagree with the limit the running server enforces, and the
 * page would then promise one size and the server refuse another.
 */

/** What a server that predates the field enforces - its old hard-coded 10MB. */
export const DEFAULT_UPLOAD_MAX_MB = 10;

const BYTES_PER_MB = 1024 * 1024;

/**
 * `uploadMaxMb` from a /auth/me response, or the default.
 *
 * Anything but a positive whole number is treated as missing: the field is
 * absent from an older backend, and a page that printed "max undefinedMB" or
 * refused every file over 0MB would be worse than the old fixed text.
 */
export function readUploadMaxMb(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_UPLOAD_MAX_MB;
}

/**
 * Why `file` would be refused for its size, or null when it would not.
 *
 * Checked before sending, because the server only says so once the upload has
 * reached the cap - on a slow connection, after a long wait for a refusal the
 * page could have given at once. The comparison is the server's: a file of
 * exactly the cap is accepted. The server still enforces it either way.
 */
export function pdfTooLargeMessage(
  file: { name: string; size: number },
  limitMb: number
): string | null {
  if (file.size <= limitMb * BYTES_PER_MB) return null;
  // The server's own 413 wording, so the refusal reads the same from either side.
  return `${file.name} is larger than ${limitMb} MB, the most this server accepts. Choose a smaller PDF.`;
}
