/**
 * Extrae el hostname de un header Host: quita el puerto, el punto final y pasa a minúsculas.
 * 'Bolivar.TuApp.com:3000' → 'bolivar.tuapp.com'. '[::1]:3000' → '::1'.
 */
export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  let value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : undefined;
  }
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  if (value.endsWith('.')) value = value.slice(0, -1);
  return value.length > 0 ? value : undefined;
}
