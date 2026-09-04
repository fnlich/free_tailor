import { getPreferredApiBase } from '@/lib/api';

export function getBidAssistantApiUrl(path) {
  const normalizedPath = path.replace(/^\/api\/?/, '').replace(/^\//, '');
  return `${getPreferredApiBase().replace(/\/$/, '')}/bid-assistant/${normalizedPath}`;
}
