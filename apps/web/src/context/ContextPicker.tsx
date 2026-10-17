import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, ContextKind } from '@agent-canvas/shared';
import { api } from '../api/http.ts';
import { IconNote, IconPlus, IconSearch } from '../icons.tsx';
import { agentNodeOf, liveMrs, useStore } from '../state/store.ts';
import { kindIcon } from './ctx-ui.tsx';
import { mrNum } from '../mrs/mr-ui.tsx';

const NONE: never[] = [];

interface Option {
  kind: ContextKind;
  ref: string;
  title: string;
  desc: string;
}

/**
 * Seletor de contexto no estilo paleta de comandos (protótipo): busca, marcação múltipla,
 * teclado (↑↓, Enter, Esc) e criação de nota ligada ao agente.
 */
export function ContextPicker({
  agent: a,
  anchor,
  onClose,
}: {
  agent: Agent;
  anchor: HTMLElement | null;
  onClose(): void;
}) {
  const ctx = useStore((s) => s.contexts[a.id]);
  const notes = useStore((s) => s.notes);
  const nodes = useStore((s) => s.nodes);
  const issues = useStore((s) => s.issues);
  const openRefs = useStore((s) => s.openIssueRefs);
  const projects = useStore((s) => s.settings?.projects ?? NONE);
  const mergeRequests = useStore((s) => s.mergeRequests);
  const mrs = useMemo(
    () => liveMrs({ nodes, mergeRequests } as Parameters<typeof liveMrs>[0]),
    [nodes, mergeRequests],
  );
  const st = useStore.getState();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nt, setNt] = useState({ title: '', body: '' });
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 352,
  });

  // arquivos do repositório do agente, buscados no bridge
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .agentFiles(a.id, q)
        .then((f) => alive && setFiles(f.slice(0, q ? 20 : 8)))
        .catch(() => alive && setFiles([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [a.id, q]);

  const on = useMemo(() => new Set(ctx?.items.map((i) => i.id) ?? []), [ctx]);
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (o: Option) => words.every((w) => `${o.title} ${o.desc}`.toLowerCase().includes(w));
    const liveNotes = Object.values(nodes)
      .filter((n) => n.type === 'note')
      .map((n) => notes[n.refId])
      .filter((x) => !!x);
    const g: [string, Option[]][] = [
      [
        'Sugeridos',
        (ctx?.suggestions ?? []).map((s) => ({ kind: s.kind, ref: s.ref, title: s.label, desc: s.why })),
      ],
      [
        'Notas',
        liveNotes.map((n) => ({
          kind: 'note' as const,
          ref: n.id,
          title: n.title,
          desc: (n.isHandoff ? 'nota de passagem · ' : '') + (n.body.split('\n')[0] || 'vazia'),
        })),
      ],
      [
        'Issues',
        openRefs
          .map((r) => issues[r])
          .filter((i) => !!i)
          .map((i) => ({
            kind: 'issue' as const,
            ref: i.ref,
            title: `#${i.iid} ${i.title}`,
            desc: i.projectPath,
          })),
      ],
      [
        'Repositórios',
        projects.map((p) => ({
          kind: 'repo' as const,
          ref: String(p.id),
          title: p.name,
          desc: `índice de ${p.pathWithNamespace}`,
        })),
      ],
      [
        'Arquivos',
        files.map((f) => ({ kind: 'file' as const, ref: f, title: f, desc: 'arquivo do repositório' })),
      ],
      [
        'Merge requests',
        mrs.map((m) => ({
          kind: 'mr_diff' as const,
          ref: m.ref,
          title: `diff do ${mrNum(m)}`,
          desc: m.title,
        })),
      ],
      [
        'Logs de pipeline',
        mrs
          .filter((m) => m.pipelineStatus === 'failed')
          .map((m) => ({
            kind: 'pipeline_log' as const,
            ref: m.ref,
            title: `log do pipeline !${m.iid}`,
            desc: m.title,
          })),
      ],
    ];
    const seen = new Set<string>();
    return g
      .map(([h, items]) => {
        const out = items.filter((o) => {
          const k = `${o.kind}:${o.ref}`;
          if (seen.has(k) || !match(o)) return false;
          seen.add(k);
          return true;
        });
        return [h, out.slice(0, q ? 20 : 6)] as [string, Option[]];
      })
      .filter(([, items]) => items.length);
  }, [ctx, notes, nodes, issues, openRefs, projects, mrs, files, q]);
  const flat = groups.flatMap(([, items]) => items);
  const cur = Math.min(idx, Math.max(0, flat.length - 1));

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const w = Math.min(352, innerWidth - 24);
      const h = pop.current?.offsetHeight ?? 400;
      if (!r) return setPos({ left: (innerWidth - w) / 2, top: 80, width: w });
      const left = Math.min(Math.max(12, r.right - w), innerWidth - w - 12);
      let top = r.bottom + 8;
      if (top + h > innerHeight - 12) top = Math.max(12, r.top - 8 - h);
      setPos({ left, top, width: w });
    };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [anchor, creating, groups.length]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    addEventListener('pointerdown', down);
    return () => removeEventListener('pointerdown', down);
  }, [anchor, onClose]);

  useEffect(() => {
    list.current?.querySelector('.cp-it.act')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const toggle = (o: Option | undefined) => {
    if (!o) return;
    const id = `${o.kind}:${o.ref}`;
    const item = ctx?.items.find((i) => i.id === id);
    if (item) {
      if (item.removable) st.contextRemove(a.id, id);
      else st.showToast('A issue e o repositório do agente definem a tarefa e não saem do contexto.');
    } else st.contextAdd(a.id, o.kind, o.ref);
  };

  const createNote = () => {
    const n = agentNodeOf(useStore.getState(), a.id);
    if (!n) return;
    const { noteId } = st.createNote({ x: n.x - 330, y: n.y + 100 }, n.id);
    st.updateNote(noteId, { title: nt.title.trim() || 'Nova nota', body: nt.body.trim() });
    st.flushNote(noteId);
    setNt({ title: '', body: '' });
    setCreating(false);
  };

  let k = 0;
  return createPortal(
    <div
      ref={pop}
      className={`cpop open${creating ? ' creating' : ''}`}
      role="dialog"
      aria-label={`Adicionar contexto a ${a.name}`}
      style={{ left: pos.left, top: pos.top, width: pos.width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (creating) setCreating(false);
          else onClose();
        }
      }}
    >
      <div className="cp-search">
        <IconSearch size={15} />
        <input
          autoFocus
          value={q}
          placeholder="Buscar notas, issues, arquivos, logs…"
          autoComplete="off"
          aria-label="Buscar contexto"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx(Math.min(cur + 1, flat.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx(Math.max(cur - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              toggle(flat[cur]);
            }
          }}
        />
      </div>
      <div className="cp-list" ref={list} role="listbox" aria-multiselectable="true">
        {groups.length ? (
          groups.map(([h, items]) => (
            <div key={h}>
              <div className="cp-h">{h}</div>
              {items.map((o) => {
                const i = k++;
                const id = `${o.kind}:${o.ref}`;
                const isOn = on.has(id);
                const { cls, icon } = kindIcon(o.kind);
                const tokens = ctx?.items.find((x) => x.id === id)?.tokens;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`cp-it${isOn ? ' on' : ''}${i === cur ? ' act' : ''}`}
                    role="option"
                    aria-selected={isOn}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => toggle(o)}
                  >
                    <span className={`ico ${cls}`}>{icon}</span>
                    <span className="tx">
                      <span className="t">{o.title}</span>
                      <span className="d">
                        {o.desc}
                        {tokens
                          ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`
                          : ''}
                      </span>
                    </span>
                    <span className="ck" aria-hidden="true">
                      {isOn ? '✓' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        ) : (
          <p className="cp-empty">Nada encontrado para "{q}".</p>
        )}
      </div>
      <div className="cp-foot">
        {creating ? (
          <div className="cp-form">
            <div className="cp-form-h">
              <button
                type="button"
                className="btn plain icon xs"
                aria-label="Voltar"
                onClick={() => setCreating(false)}
              >
                ←
              </button>
              <b>Nova nota para {a.name}</b>
            </div>
            <input
              className="field"
              autoFocus
              placeholder="Título da nota"
              value={nt.title}
              onChange={(e) => setNt({ ...nt, title: e.target.value })}
            />
            <textarea
              className="field"
              rows={5}
              placeholder="Decisões, regras de negócio, links, trechos de log…"
              value={nt.body}
              onChange={(e) => setNt({ ...nt, body: e.target.value })}
            />
            <div className="row2" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn sm plain" onClick={() => setCreating(false)}>
                Cancelar
              </button>
              <button type="button" className="btn sm primary" onClick={createNote}>
                Criar e adicionar
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="cp-it cp-new" onClick={() => setCreating(true)}>
              <span className="ico note">
                <IconNote />
              </span>
              <span className="tx">
                <span className="t">Nova nota</span>
                <span className="d">Escreva um contexto do zero e ligue a este agente</span>
              </span>
              <span className="ck plus" aria-hidden="true">
                <IconPlus size={12} />
              </span>
            </button>
            <div className="cp-hint">
              <span>{ctx?.items.length ? `${ctx.items.length} no contexto` : 'Nada no contexto'}</span>
              <span>
                <kbd>↑↓</kbd> navegar · <kbd>Enter</kbd> marcar · <kbd>Esc</kbd> fechar
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
