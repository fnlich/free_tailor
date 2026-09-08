/**
 * `PORT` and the port inside `NEXT_PUBLIC_API_URL` are two variables that must
 * agree: the first is where this server listens, the second is where the
 * browser looks. `.env.example` spells both out, so changing one and forgetting
 * the other is a single-keystroke mistake - and the result is invisible from
 * the browser, because a wrong port and a stopped server are the same
 * `TypeError: Failed to fetch`. The page can only report that it cannot reach
 * the API.
 *
 * This process can see both values (config/env.ts loads the whole repository
 * `.env`), so it is the one place that can state the contradiction plainly.
 * Kept as a pure function, separate from index.ts, so the rules below are
 * pinned by tests rather than only exercised at startup.
 */

/** Hostnames that mean "this machine", as WHATWG URL parsing reports them. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type ApiPortMismatch = {
  /** The origin the frontend was pointed at. */
  configuredOrigin: string;
  /** The port it names, with the protocol default filled in. */
  configuredPort: string;
  /** The port this server actually listens on. */
  serverPort: string;
};

/**
 * Reports a same-machine port disagreement, or null when there is nothing
 * wrong to say.
 *
 * Returns null - deliberately - when the configured URL names a DIFFERENT host.
 * Pointing the frontend at another machine is a legitimate split deployment,
 * and the port there has nothing to do with this server's. Only a disagreement
 * about the same machine is a mistake.
 */
export function findApiPortMismatch(
  configuredApiUrl: string | undefined,
  serverPort: number | string
): ApiPortMismatch | null {
  const configured = configuredApiUrl?.trim();
  if (!configured) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }

  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    return null;
  }

  // An omitted port means the protocol's default, which is still a port the
  // backend is almost certainly not on.
  const configuredPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (configuredPort === String(serverPort)) {
    return null;
  }

  return { configuredOrigin: url.origin, configuredPort, serverPort: String(serverPort) };
}

export function describeApiPortMismatch(mismatch: ApiPortMismatch): string {
  return (
    `[env] NEXT_PUBLIC_API_URL points the frontend at ${mismatch.configuredOrigin}, ` +
    `but this server is on port ${mismatch.serverPort}. Every API call will fail, and the browser ` +
    'cannot tell a wrong port from a stopped server - it will only say it cannot reach the backend. ' +
    'Set PORT and NEXT_PUBLIC_API_URL to the same port in the repository .env, or remove ' +
    'NEXT_PUBLIC_API_URL to derive it from PORT.'
  );
}
