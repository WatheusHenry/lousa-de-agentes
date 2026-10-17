import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { addIssue, newAgentAt, newNoteAt } from '../actions.ts';
import { reposText, statusLabel } from '../agents/agent-ui.ts';
import { fit, focusNode } from '../canvas/viewport.ts';
import {
  IconAgent,
  IconBolt,
  IconFit,
  IconGear,
  IconHelp,
  IconIssue,
  IconMr,
  IconNewNote,
  IconNote,
  IconPlus,
  IconSearch,
  IconTheme,
} from '../icons.tsx';
import { firstLine } from '../lib/format.ts';
import { useStore } from '../state/store.ts';
import { effectiveTheme, toggleTheme } from '../theme.ts';

interface Item {
  id: string;
  group: string;
  icon: ReactNode;
  cls: string;
  title: string;
  desc: string;
  run(): void;
}

/** Busca sem acento e sem caixa: "acoes" acha "Ações". */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const GROUP_ORDER = ['No canvas', 'Ações', 'Issues para trazer ao canvas'];

/**
 * Paleta de comandos (Ctrl/⌘ + K): acha qualquer agente, issue, nota ou MR do canvas, traz uma
 * issue do backlog e roda as ações mais usadas, tudo pelo teclado.
 */
export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    // lido uma vez ao abrir: a paleta não acompanha o canvas enquanto está aberta
    const st = useStore.getState();
    const out: Item[] = [];
    const projects = st.settings?.projects ?? [];
    for (const n of Object.values(st.nodes)) {
      const go = () => focusNode(n.id);
      if (n.type === 'agent') {
        const a = st.agents[n.refId];
        if (a)
          out.push({
            id: n.id,
            group: 'No canvas',
            icon: <IconAgent />,
            cls: 'agent',
            title: `${a.name} · ${a.title}`,
            desc: `${statusLabel(a.status)} · ${reposText(a, projects)}`,
            run: go,
          });
      } else if (n.type === 'issue') {
        const i = st.issues[n.refId];
        if (i)
          out.push({
            id: n.id,
            group: 'No canvas',
            icon: <IconIssue />,
            cls: 'issue',
            title: `#${i.iid} ${i.title}`,
            desc: i.projectPath,
            run: go,
          });
      } else if (n.type === 'mr') {
        const m = st.mergeRequests[n.refId];
        if (m)
          out.push({
            id: n.id,
            group: 'No canvas',
            icon: <IconMr />,
            cls: 'mr',
            title: `!${m.iid} ${m.title}`,
            desc: `${m.projectPath} · pipeline ${m.pipelineStatus}`,
            run: go,
          });
      } else if (n.type === 'note') {
        const nt = st.notes[n.refId];
        if (nt)
          out.push({
            id: n.id,
            group: 'No canvas',
            icon: <IconNote />,
            cls: 'note',
            title: nt.title,
            desc: firstLine(nt.body),
            run: go,
          });
      }
    }
    const actions: [string, ReactNode, string, () => void][] = [
      ['Novo agente', <IconPlus key="a" />, 'Agente em branco no meio da tela', () => newAgentAt()],
      ['Nova nota', <IconNewNote key="n" />, 'Nota no meio da tela', () => newNoteAt()],
      ['Ajustar', <IconFit key="f" />, 'Enquadra tudo na tela', () => fit(true)],
      [
        'Ir para Ações',
        <IconBolt key="c" />,
        'Permissões, perguntas e MRs esperando você',
        () => st.setTab('actions'),
      ],
      [
        'Automações e agentes',
        <IconBolt key="u" />,
        'Regras, avisos, modelo e limites',
        () => st.setPanel('auto'),
      ],
      [
        'Configurar GitLab',
        <IconGear key="g" />,
        'Token, instância, pasta dos repositórios',
        () => st.setSettingsOpen(true),
      ],
      [
        effectiveTheme() === 'dark' ? 'Tema claro' : 'Tema escuro',
        <IconTheme key="t" />,
        'Troca o tema (escolha fixa em Automações e agentes)',
        toggleTheme,
      ],
      ['Como funciona', <IconHelp key="h" />, 'Guia rápido e atalhos', () => st.setPanel('help')],
    ];
    for (const [title, icon, desc, run] of actions)
      out.push({ id: `act:${title}`, group: 'Ações', icon, cls: 'act', title, desc, run });
    const onCanvas = new Set(
      Object.values(st.nodes)
        .filter((n) => n.type === 'issue')
        .map((n) => n.refId),
    );
    for (const ref of st.openIssueRefs) {
      const i = st.issues[ref];
      if (!i || onCanvas.has(ref)) continue;
      out.push({
        id: `add:${ref}`,
        group: 'Issues para trazer ao canvas',
        icon: <IconIssue />,
        cls: 'issue',
        title: `#${i.iid} ${i.title}`,
        desc: `${i.projectPath} · Enter adiciona ao canvas`,
        run: () => addIssue(ref),
      });
    }
    return out;
  }, [open]);

  const shown = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const hit = items.filter((it) => {
      const text = norm(`${it.title} ${it.desc}`);
      return words.every((w) => text.includes(w));
    });
    // sem busca, as issues do backlog não enchem a lista
    return GROUP_ORDER.flatMap((g) =>
      hit.filter((it) => it.group === g).slice(0, !words.length && g !== 'Ações' ? 6 : 12),
    );
  }, [items, q]);

  useEffect(() => {
    if (!open) {
      setQ('');
      setIdx(0);
    }
  }, [open]);
  useEffect(() => {
    list.current?.querySelector('.cp-it.act')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;
  const cur = Math.min(idx, Math.max(shown.length - 1, 0));
  const pick = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    it.run();
  };

  let lastGroup = '';
  return createPortal(
    <div className="pal-bg" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cpop open palette" role="dialog" aria-label="Buscar e executar">
        <div className="cp-search">
          <IconSearch size={15} />
          <input
            autoFocus
            value={q}
            placeholder="Buscar agentes, issues, notas, MRs ou ações…"
            autoComplete="off"
            aria-label="Buscar"
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx(Math.min(cur + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx(Math.max(cur - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(shown[cur]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="cp-list" ref={list} role="listbox">
          {shown.length ? (
            shown.map((it, i) => {
              const head = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              return (
                <div key={it.id}>
                  {head && <div className="cp-h">{head}</div>}
                  <button
                    type="button"
                    className={`cp-it${i === cur ? ' act' : ''}`}
                    role="option"
                    aria-selected={i === cur}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => pick(it)}
                  >
                    <span className={`ico ${it.cls}`}>{it.icon}</span>
                    <span className="tx">
                      <span className="t">{it.title}</span>
                      <span className="d">{it.desc}</span>
                    </span>
                  </button>
                </div>
              );
            })
          ) : (
            <p className="cp-empty">Nada encontrado para "{q}".</p>
          )}
        </div>
        <div className="cp-foot">
          <div className="cp-hint">
            <span>Ctrl/⌘ + K abre e fecha</span>
            <span>
              <kbd>↑↓</kbd> navegar · <kbd>Enter</kbd> abrir · <kbd>Esc</kbd> fechar
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
