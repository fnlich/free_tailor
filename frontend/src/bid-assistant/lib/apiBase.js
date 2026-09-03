const DEFAULT_LOCAL_API_BASE = 'http://localhost:3001/api';
const CONFIGURED_API_BASE = process.env.NEXT_PUBLIC_API_URL || DEFAULT_LOCAL_API_BASE;

function getBrowserMatchedApiBase() {
  if (typeof window === 'undefined') return null;

  try {
    const configuredUrl = new URL(CONFIGURED_API_BASE);
    configuredUrl.hostname = window.location.hostname;
    return configuredUrl.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function getBidAssistantApiUrl(path) {
  const normalizedPath = path.replace(/^\/api\/?/, '').replace(/^\//, '');
  const apiBase = getBrowserMatchedApiBase() || CONFIGURED_API_BASE.replace(/\/$/, '');

  return `${apiBase}/bid-assistant/${normalizedPath}`;
}
