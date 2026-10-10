import { useEffect, useState } from 'react';

export type ColorMode = 'light' | 'dark';
const KEY = 'tenancy-admin:color-mode';

function stored(): ColorMode | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function system(): ColorMode {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Aplica el modo guardado o el del sistema. Se llama antes de montar la app. */
export function applyColorMode(mode: ColorMode = stored() ?? system()): ColorMode {
  document.documentElement.dataset.theme = mode;
  return mode;
}

/** Modo claro/oscuro: sigue al sistema hasta que el usuario elige uno. */
export function useColorMode(): [ColorMode, () => void] {
  const [mode, setMode] = useState<ColorMode>(
    () => (document.documentElement.dataset.theme as ColorMode | undefined) ?? applyColorMode(),
  );
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const follow = () => {
      if (!stored()) setMode(applyColorMode(system()));
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  const toggle = () => {
    const next: ColorMode = mode === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Sin almacenamiento (modo privado): el cambio vale hasta recargar.
    }
    setMode(applyColorMode(next));
  };
  return [mode, toggle];
}
