import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { TenancyError } from '@tenancy-node/core';

export class UnsafeWebhookUrlError extends TenancyError {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super('TENANCY_UNSAFE_WEBHOOK_URL', `Webhook URL not allowed (${reason}): ${url}`, { url });
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // metadata de nubes (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Protección contra SSRF: solo http(s) y ningún destino que resuelva a una IP interna
 * (loopback, redes privadas, link-local/metadata, CGNAT, multicast).
 */
export async function assertPublicUrl(
  raw: string,
  options: { allowPrivateNetworks?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError(raw, 'invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new UnsafeWebhookUrlError(raw, 'only http and https');
  if (url.username || url.password) throw new UnsafeWebhookUrlError(raw, 'credentials in the URL');
  if (options.allowPrivateNetworks) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new UnsafeWebhookUrlError(raw, 'host does not resolve');
  if (addresses.some(isPrivateAddress))
    throw new UnsafeWebhookUrlError(raw, 'resolves to a private or internal address');
  return url;
}
