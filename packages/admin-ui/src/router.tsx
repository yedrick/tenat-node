import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export const BASE_PATH = '/admin';
const listeners = new Set<() => void>();

export function currentPath(): string {
  const path = window.location.pathname.startsWith(BASE_PATH)
    ? window.location.pathname.slice(BASE_PATH.length)
    : window.location.pathname;
  return path || '/';
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = BASE_PATH + to;
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const update = () => setPath(currentPath());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

/** `/tenants/:id` contra `/tenants/bolivar` → `{ id: 'bolivar' }`, o `null`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-zA-Z]+)/g, (_, n: string) => (names.push(n), '([^/]+)'))}/?$`,
  );
  const m = regex.exec(path);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
}

export function Link({
  to,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...props}
      href={BASE_PATH + to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
