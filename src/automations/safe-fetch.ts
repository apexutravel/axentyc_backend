import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('ff')) return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * Outbound webhook call that cannot be aimed at internal services (SSRF): https only, the host must
 * resolve to public addresses, redirects are not followed, and the call is time-limited.
 */
export async function safePostJson(rawUrl: string, body: unknown, timeoutMs = 5000): Promise<number> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida');
  }
  if (url.protocol !== 'https:') throw new Error('El webhook debe usar https');
  if (url.username || url.password) throw new Error('La URL no puede incluir credenciales');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('El destino del webhook no es público');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'AXENTYC-Automations/1.0' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 400) throw new Error(`El webhook respondió ${res.status}`);
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}
