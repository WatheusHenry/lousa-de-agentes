import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { addIssue, newAgentAt, newBrowserAt, newNoteAt, noteFor, startFromCard } from '../actions.ts';
import { isLive, roleLabel } from '../agents/agent-ui.ts';
import {
  IconDoc,
  IconAgent,
  IconExpand,
  IconFit,
  IconGlobe,
  IconReload,
  IconHelp,
  IconIssue,
  IconNote,
  IconPause,
  IconPlay,
  IconSide,
  IconStop,
  IconTrash,
} from '../icons.tsx';
import { useStore } from '../state/store.ts';
import { fit, screenToFlow } from './viewport.ts';

type Item =
  | { sep: true }
  | { header: string }
  | { icon?: ReactNode; label: string; hint?: string; danger?: boolean; run: () => void };

const useMenu = create<{ open: boolean; x: number; y: number; items: Item[] }>(() => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
}));

const closeMenu = () => useMenu.setState({ open: false });

function canvasMenu(at: { x: number; y: number }): Item[] {
  const s = useStore.getState();
  const onCanvas = new Set(
    Object.values(s.nodes)
      .filter((n) => n.type === 'issue')
      .map((n) => n.refId),
  );
  const backlog = s.openIssueRefs.filter((r) => !onCanvas.has(r)).slice(0, 4);
  const wide = innerWidth > 860;
  return [
    {
      icon: <IconAgent />,
      label: 'Novo agente aqui',
      run: () => newAgentAt({ x: at.x + 200, y: at.y + 160 }),
    },
    { icon: <IconNote />, label: 'Nova nota aqui', hint: 'Duplo clique', run: () => newNoteAt(at) },
    {
      icon: <IconGlobe />,
      label: 'Novo navegador aqui',
      run: () => newBrowserAt({ x: at.x + 330, y: at.y + 235 }),
    },
    ...(backlog.length
      ? [
          { sep: true } as const,
          { header: 'Adicionar issue aqui' },
          ...backlog.map((ref) => {
            const i = s.issues[ref]!;
            return {
              icon: <IconIssue />,
              label: `#${i.iid} ${i.title}`,
              run: () => addIssue(ref, { x: at.x + 142, y: at.y + 70 }),
            };
          }),
        ]
      : []),
    { sep: true },
    { icon: <IconFit />, label: 'Ajustar à tela', run: () => fit(true) },
    ...(wide
      ? [
          {
            icon: <IconSide />,
            label: s.sideHidden ? 'Mostrar barra lateral' : 'Ocultar barra lateral',
            hint: 'Ctrl B',
            run: () => s.setSideHidden(!s.sideHidden),
          },
        ]
      : []),
    { icon: <IconHelp />, label: 'Como funciona', run: () => s.setPanel('help') },
  ];
}

function nodeMenu(id: string): Item[] {
  const s = useStore.getState();
  const n = s.nodes[id];
  if (!n) return [];
  const rm: Item = {
    icon: <IconTrash />,
    label: n.type === 'note' ? 'Excluir nota' : 'Remover do canvas',
    hint: 'Delete',
    danger: true,
    run: () => s.removeNode(id),
  };
  if (n.type === 'agent') {
    const a = s.agents[n.refId];
    if (!a) return [];
    const live = isLive(a);
    return [
      { header: `${a.name} · ${roleLabel(a)}` },
      { icon: <IconExpand />, label: 'Abrir em foco', hint: 'Duplo clique', run: () => s.openFocus(id) },
      ...(live ? [{ icon: <IconPause />, label: 'Pausar', run: () => s.pauseAgent(a.id) }] : []),
      ...((a.status === 'paused' || a.status === 'error') && a.sessionId
        ? [{ icon: <IconPlay />, label: 'Retomar', run: () => s.resumeAgent(a.id) }]
        : []),
      { label: 'Renomear', hint: 'Duplo clique no nome', run: () => s.setRenaming(a.id) },
      { icon: <IconNote />, label: 'Nova nota ligada', run: () => noteFor(id) },
      {
        icon: <IconGlobe />,
        label: 'Abrir navegador do agente',
        run: () => {
          const own = Object.values(s.browsers).find(
            (b) => b.ownerAgentId === a.id && Object.values(s.nodes).some((x) => x.refId === b.id),
          );
          const ownNode = own && Object.values(s.nodes).find((x) => x.type === 'browser' && x.refId === own.id);
          if (ownNode) s.select(ownNode.id);
          else newBrowserAt(undefined, { agentId: a.id });
        },
      },
      { sep: true },
      ...(live ? [{ icon: <IconStop />, label: 'Parar', danger: true, run: () => s.stopAgent(a.id) }] : []),
      rm,
    ];
  }
  if (n.type === 'issue') {
    const i = s.issues[n.refId];
    return [
      { header: `Issue #${i?.iid ?? ''}` },
      { icon: <IconExpand />, label: 'Expandir', hint: 'Duplo clique', run: () => s.openFocus(id) },
      { icon: <IconAgent />, label: 'Iniciar agente', run: () => void startFromCard(id) },
      { icon: <IconNote />, label: 'Nova nota ligada', run: () => noteFor(id) },
      { sep: true },
      { icon: <IconDoc />, label: 'Arquivar com agentes e MRs', run: () => s.archiveIssue(id) },
      rm,
    ];
  }
  if (n.type === 'browser') {
    const b = s.browsers[n.refId];
    return [
      { header: `Navegador · ${b?.title || b?.url || ''}` },
      { icon: <IconExpand />, label: 'Abrir em foco', run: () => s.openFocus(id) },
      { icon: <IconReload />, label: 'Recarregar', run: () => s.navigateBrowser(n.refId, { action: 'reload' }) },
      { sep: true },
      { ...rm, label: 'Fechar navegador' },
    ];
  }
  const note = s.notes[n.refId];
  return [
    { header: `Nota · ${note?.title ?? ''}` },
    { icon: <IconExpand />, label: 'Expandir', hint: 'Duplo clique', run: () => s.openFocus(id) },
    { sep: true },
    rm,
  ];
}

export function openContextMenu(e: MouseEvent, nodeId: string | null) {
  e.preventDefault();
  const at = screenToFlow(e.clientX, e.clientY);
  if (nodeId) useStore.getState().select(nodeId);
  const items = nodeId ? nodeMenu(nodeId) : canvasMenu(at);
  if (items.length) useMenu.setState({ open: true, x: e.clientX, y: e.clientY, items });
}

/** Menu do botão direito: material translúcido, teclado com setas, abre na posição do cursor. */
export function ContextMenu() {
  const { open, x, y, items } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ left: x, top: y, origin: 'left top' });

  // abre na posição do cursor; vira para o outro lado perto das bordas
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = x,
      top = y,
      ox = 'left',
      oy = 'top';
    if (x + w > innerWidth - 8) {
      left = Math.max(8, x - w);
      ox = 'right';
    }
    if (y + h > innerHeight - 8) {
      top = Math.max(8, y - h);
      oy = 'bottom';
    }
    setPos({ left, top, origin: `${ox} ${oy}` });
    setActive(-1);
    ref.current.focus({ preventScroll: true });
  }, [open, x, y, items]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && closeMenu();
    addEventListener('pointerdown', down, true);
    addEventListener('resize', closeMenu);
    addEventListener('blur', closeMenu);
    addEventListener('wheel', closeMenu, { passive: true });
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('resize', closeMenu);
      removeEventListener('blur', closeMenu);
      removeEventListener('wheel', closeMenu);
    };
  }, [open]);

  const runnable = items.map((it, i) => ('run' in it ? i : -1)).filter((i) => i >= 0);
  const run = (i: number) => {
    const it = items[i];
    if (!it || !('run' in it)) return;
    closeMenu();
    it.run();
  };

  return (
    <div
      ref={ref}
      className={`cmenu${open ? ' open' : ''}`}
      role="menu"
      aria-label="Ações rápidas"
      tabIndex={-1}
      inert={!open}
      style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => setActive(-1)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const p = runnable.indexOf(active);
          const d = e.key === 'ArrowDown' ? 1 : -1;
          setActive(
            runnable[
              p < 0 ? (d > 0 ? 0 : runnable.length - 1) : (p + d + runnable.length) % runnable.length
            ] ?? -1,
          );
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (active >= 0) run(active);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
        }
      }}
    >
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={i} className="cm-sep" role="separator" />
        ) : 'header' in it ? (
          <div key={i} className="cm-h">
            {it.header}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`cm-it${it.danger ? ' danger' : ''}${active === i ? ' act' : ''}`}
            onPointerMove={() => active !== i && setActive(i)}
            onClick={() => run(i)}
          >
            <span className="cm-ic">{it.icon}</span>
            <span className="cm-l">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export const isMenuOpen = () => useMenu.getState().open;
export { closeMenu };
