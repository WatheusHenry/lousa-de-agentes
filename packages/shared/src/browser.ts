import { z } from 'zod';

/** Tamanho da página dos navegadores do canvas (em px CSS); a tela no cartão é escalada. */
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

export const BrowserStatus = z.enum([
  /** Sem página aberta (o bridge reiniciou, ou ninguém olhou ainda): abre ao ser usado. */
  'off',
  'loading',
  'ready',
  'error',
]);
export type BrowserStatus = z.infer<typeof BrowserStatus>;

/** Navegador no canvas: uma aba do Chrome headless que o bridge controla. */
export const Browser = z.object({
  id: z.string().min(1).max(64),
  url: z.string(),
  title: z.string(),
  /** Agente que abriu (ou para quem o usuário abriu) o navegador. */
  ownerAgentId: z.string().nullable(),
  status: BrowserStatus,
  /** Por que o navegador não abriu (ex.: nenhum Chrome/Edge encontrado). */
  error: z.string().nullable(),
  canBack: z.boolean(),
  canForward: z.boolean(),
});
export type Browser = z.infer<typeof Browser>;

/** Endereços que um navegador do canvas aceita abrir. */
export function normalizeBrowserUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === 'about:blank') return 'about:blank';
  // "localhost:3000" e "exemplo.com" sem esquema
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    ? s
    : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)
      ? `http://${s}`
      : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Entrada do usuário na tela do navegador, repassada ao Chrome. Coordenadas na página. */
export const BrowserInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['none', 'left', 'middle', 'right']).default('left'),
    clickCount: z.number().int().min(0).max(3).default(1),
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.object({
    kind: z.literal('wheel'),
    x: z.number().finite(),
    y: z.number().finite(),
    dx: z.number().finite(),
    dy: z.number().finite(),
  }),
  z.object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string().max(40),
    code: z.string().max(40),
    keyCode: z.number().int().min(0).max(255),
    /** Texto digitado (teclas que escrevem algo). */
    text: z.string().max(4).optional(),
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  /** Texto colado. */
  z.object({ kind: z.literal('text'), text: z.string().max(20_000) }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;
