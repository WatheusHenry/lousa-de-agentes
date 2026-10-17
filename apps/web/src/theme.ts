/**
 * Tema claro ou escuro. "Sistema" segue a preferência do sistema operacional (e acompanha a
 * troca dela); a escolha manual vira data-theme no <html>, que os tokens de tokens.css leem.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'ac-theme';
const listeners = new Set<(p: ThemePref) => void>();

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** O tema que está valendo agora (a escolha manual ou o do sistema). */
export function effectiveTheme(p = themePref()): 'light' | 'dark' {
  if (p !== 'system') return p;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(p = themePref()): void {
  const root = document.documentElement;
  if (p === 'system') delete root.dataset.theme;
  else root.dataset.theme = p;
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
  applyTheme(p);
  for (const l of listeners) l(p);
}

/** Troca entre claro e escuro a partir do que está na tela. */
export function toggleTheme(): void {
  setThemePref(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(l: (p: ThemePref) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
