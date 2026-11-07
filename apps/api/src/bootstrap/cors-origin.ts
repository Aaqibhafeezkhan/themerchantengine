type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Allowlist check for `enableCors`. An unlisted origin gets no CORS headers
 * (the browser blocks the call) instead of an Error, which Nest would turn
 * into a 500 and an error-level log line.
 */
export function corsOriginCheck(allowed: readonly string[]) {
  return (origin: string | undefined, callback: OriginCallback): void => {
    // No origin means server-to-server, curl or a same-origin request.
    if (!origin) return callback(null, true);
    callback(null, allowed.includes(origin));
  };
}
