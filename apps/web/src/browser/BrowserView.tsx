import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { BROWSER_VIEWPORT, type Browser } from '@agent-canvas/shared';
import { IconBack, IconForward, IconGlobe, IconReload } from '../icons.tsx';
import { useStore } from '../state/store.ts';

/** Bits de modificador do Chrome DevTools: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const BUTTONS = ['left', 'middle', 'right'] as const;

/** Endereço sem o esquema, como na barra dos navegadores. */
export const shortUrl = (url: string) =>
  url === 'about:blank' ? '' : url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Barra de endereço com voltar, avançar e recarregar. */
export function BrowserBar({ browser: b }: { browser: Browser }) {
  const navigate = useStore((s) => s.navigateBrowser);
  const [url, setUrl] = useState(shortUrl(b.url));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setUrl(shortUrl(b.url));
  }, [b.url, editing]);
  return (
    <form
      className="bnav nodrag"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) navigate(b.id, { url: url.trim() });
        (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
      }}
    >
      <button
        type="button"
        className="btn plain icon xs"
        aria-label="Voltar"
        title="Voltar"
        disabled={!b.canBack}
        onClick={() => navigate(b.id, { action: 'back' })}
      >
        <IconBack />
      </button>
      <button
        type="button"
        className="btn plain icon xs"
        aria-label="Avançar"
        title="Avançar"
        disabled={!b.canForward}
        onClick={() => navigate(b.id, { action: 'forward' })}
      >
        <IconForward />
      </button>
      <button
        type="button"
        className={`btn plain icon xs${b.status === 'loading' ? ' spin' : ''}`}
        aria-label="Recarregar"
        title="Recarregar"
        onClick={() => navigate(b.id, { action: 'reload' })}
      >
        <IconReload />
      </button>
      <input
        className="burl"
        value={url}
        placeholder="Digite um endereço (ex.: localhost:5173)"
        aria-label="Endereço"
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setUrl(shortUrl(b.url));
            e.currentTarget.blur();
          }
        }}
      />
    </form>
  );
}

/**
 * Tela ao vivo do navegador (quadros do screencast do Chrome). Cliques, rolagem, teclado e colar
 * vão para a página; coordenadas convertidas da imagem escalada para a página de 1280×800.
 */
export function BrowserScreen({ browser: b, className = '' }: { browser: Browser; className?: string }) {
  const frame = useStore((s) => s.browserFrames[b.id]);
  const input = useStore((s) => s.browserInput);
  const watch = useStore((s) => s.watchBrowser);
  const box = useRef<HTMLDivElement>(null);
  const lastMove = useRef(0);

  // o cartão apareceu (ou o bridge reiniciou): pede a página e o quadro atual
  useEffect(() => {
    watch(b.id);
  }, [b.id, watch]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    const w = frame?.width || BROWSER_VIEWPORT.width;
    const h = frame?.height || BROWSER_VIEWPORT.height;
    return {
      x: Math.max(0, Math.min(w, ((e.clientX - r.left) / r.width) * w)),
      y: Math.max(0, Math.min(h, ((e.clientY - r.top) / r.height) * h)),
    };
  };

  const mouse = (e: PointerEvent, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
    const p = at(e);
    input(b.id, {
      kind: 'mouse',
      type,
      ...p,
      button: BUTTONS[e.button] ?? 'left',
      clickCount: type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: mods(e),
    });
  };

  const key = (e: KeyboardEvent, type: 'keyDown' | 'keyUp') => {
    e.stopPropagation(); // Delete, setas e atalhos do canvas não valem aqui dentro
    // Ctrl/⌘ + V: deixa o navegador disparar o evento de colar (tratado em onPaste)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    const text =
      type === 'keyDown' && !e.ctrlKey && !e.metaKey
        ? e.key.length === 1
          ? e.key
          : e.key === 'Enter'
            ? '\r'
            : undefined
        : undefined;
    input(b.id, {
      kind: 'key',
      type,
      key: e.key.slice(0, 40),
      code: e.code.slice(0, 40),
      keyCode: e.keyCode & 255,
      ...(text ? { text } : {}),
      modifiers: mods(e),
    });
  };

  const off = b.status !== 'ready' && !frame;
  return (
    <div
      ref={box}
      className={`bscreen nodrag nowheel nopan ${className}`}
      tabIndex={0}
      role="application"
      aria-label={`Página ${b.title || shortUrl(b.url) || 'em branco'}. Clique para usar; o teclado vai para a página.`}
      onPointerDown={(e) => {
        e.stopPropagation();
        box.current?.focus({ preventScroll: true });
        box.current?.setPointerCapture(e.pointerId);
        mouse(e, 'mousePressed');
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        mouse(e, 'mouseReleased');
      }}
      onPointerMove={(e) => {
        const now = performance.now();
        if (now - lastMove.current < 50) return;
        lastMove.current = now;
        mouse(e, 'mouseMoved');
      }}
      onWheel={(e: WheelEvent) => {
        e.stopPropagation();
        input(b.id, { kind: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => key(e, 'keyDown')}
      onKeyUp={(e) => key(e, 'keyUp')}
      onPaste={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData.getData('text/plain');
        if (text) input(b.id, { kind: 'text', text: text.slice(0, 20_000) });
      }}
    >
      {frame && (
        <img
          src={`data:image/jpeg;base64,${frame.data}`}
          alt=""
          draggable={false}
          width={frame.width}
          height={frame.height}
        />
      )}
      {off && (
        <div className={`bstate${b.status === 'error' ? ' bad' : ''}`}>
          <IconGlobe size={22} />
          <span>
            {b.status === 'error'
              ? (b.error ?? 'O navegador não abriu.')
              : b.status === 'loading'
                ? 'Abrindo…'
                : 'Digite um endereço acima'}
          </span>
        </div>
      )}
      {b.status === 'error' && frame && <div className="berr">{b.error}</div>}
    </div>
  );
}
