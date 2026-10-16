import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IssueComment } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { noteFor } from '../actions.ts';
import { nodeScreenRect, reducedMotion } from '../canvas/viewport.ts';
import { IconAgent, IconIssue, IconNote } from '../icons.tsx';
import {
  checklist,
  descriptionWithoutChecklist,
  firstLine,
  initials,
  isRedLabel,
  repoName,
  timeAgo,
} from '../lib/format.ts';
import { useStore } from '../state/store.ts';

/** Qualquer item abre grande, com o fundo do canvas borrado. Issue vira documento; nota vira editor. */
export function Focus() {
  const focusId = useStore((s) => s.focusId);
  const node = useStore((s) => (s.focusId ? s.nodes[s.focusId] : undefined));
  const sideHidden = useStore((s) => s.sideHidden);
  const inspOpen = useStore((s) => !!(s.selected || s.panel));
  const sheet = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  // o último item aberto continua desenhado durante a animação de saída
  const [shownId, setShownId] = useState<string | null>(focusId);
  const closingFrom = useRef<string | null>(null);

  useEffect(() => {
    if (focusId) setShownId(focusId);
  }, [focusId]);

  // abre a partir do cartão no canvas (FLIP); fecha voltando para ele
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    if (focusId) {
      flip(el, focusId, true);
    } else if (shownId && closingFrom.current === shownId) {
      const anim = flip(el, shownId, false);
      if (bg.current) bg.current.style.opacity = '0';
      const done = () => {
        if (bg.current) bg.current.style.opacity = '';
        setShownId(null);
      };
      if (anim) anim.onfinish = done;
      else done();
    } else if (shownId) {
      setShownId(null);
    }
    closingFrom.current = null;
  }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusId) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        useStore.getState().openFocus(null); // atalho de teclado: sem animação
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [focusId]);

  const closeAnimated = () => {
    closingFrom.current = focusId;
    useStore.getState().openFocus(null);
  };

  const wide = innerWidth > 860;
  const style = {
    left: wide && !sideHidden ? 320 : wide ? 12 : 8,
    right: wide && inspOpen ? 396 : wide ? 12 : 8,
    top: 60,
    bottom: wide ? 12 : 76,
  };
  const shown = node ?? (shownId ? useStore.getState().nodes[shownId] : undefined);
  const isOpen = !!focusId || !!shownId;

  return (
    <div className={`focus${isOpen ? ' open' : ''}`} aria-hidden={!isOpen}>
      <div className="focus-bg" ref={bg} onClick={closeAnimated} />
      <div
        className="focus-sheet"
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fName"
        style={style}
      >
        {shown?.type === 'issue' && <IssueDoc nodeId={shown.id} onClose={closeAnimated} />}
        {shown?.type === 'note' && <NoteDoc nodeId={shown.id} onClose={closeAnimated} />}
      </div>
    </div>
  );
}

function flip(sheet: HTMLElement, nodeId: string, opening: boolean): Animation | null {
  const from = nodeScreenRect(nodeId);
  const to = sheet.getBoundingClientRect();
  if (!from || !to.width) return null;
  const tf = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  const frames = reducedMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { transform: tf, opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ];
  return sheet.animate(opening ? frames : frames.slice().reverse(), {
    duration: opening ? 340 : 240,
    easing: opening ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'cubic-bezier(0.23, 1, 0.32, 1)',
  });
}

function Head({
  icon,
  name,
  sub,
  status,
  onClose,
}: {
  icon: ReactNode;
  name: string;
  sub: string;
  status: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="f-head">
      <span className="f-ico">{icon}</span>
      <span className="wname" id="fName">
        {name}
      </span>
      <span className="wsub">{sub}</span>
      {status}
      <button className="btn plain icon" aria-label="Fechar modo foco" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

function IssueDoc({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const issue = useStore((s) => (node ? s.issues[node.refId] : undefined));
  const noteLinks = useStore((s) => s.noteLinks);
  const allNotes = useStore((s) => s.notes);
  const nodes = useStore((s) => s.nodes);
  const notes = useMemo(
    () =>
      noteLinks
        .filter((l) => l.targetNodeId === nodeId)
        .map((l) => ({
          note: allNotes[l.noteId],
          nodeId: Object.values(nodes).find((n) => n.type === 'note' && n.refId === l.noteId)?.id,
        }))
        .filter((x) => x.note && x.nodeId),
    [noteLinks, allNotes, nodes, nodeId],
  );
  const openFocus = useStore((s) => s.openFocus);
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!issue) return;
    let alive = true;
    setComments(null);
    setError(null);
    api
      .comments(issue.projectId, issue.iid)
      .then((c) => alive && setComments(c))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : 'Falha ao carregar a discussão.'));
    return () => {
      alive = false;
    };
  }, [issue?.projectId, issue?.iid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!issue) return null;
  const crit = checklist(issue.description);
  const desc = descriptionWithoutChecklist(issue.description);

  return (
    <div className="f-main">
      <Head
        icon={
          <span className="ico issue">
            <IconIssue />
          </span>
        }
        name={`Issue #${issue.iid}`}
        sub={issue.projectPath}
        status={
          <span className="badge ok">
            <span className="d" />
            Aberta
          </span>
        }
        onClose={onClose}
      />
      <div className="f-body doc">
        <div className="fx">
          <div className="fx-head">
            <div className="tags">
              {issue.labels.map((l) => (
                <span key={l} className={`badge ${isRedLabel(l) ? 'issue' : ''}`}>
                  {l}
                </span>
              ))}
              <span className="badge repo">{repoName(issue)}</span>
            </div>
            <h2 className="fx-title">{issue.title}</h2>
            <p className="fx-meta">
              Aberta por @{issue.author} · {issue.commentCount} comentário
              {issue.commentCount === 1 ? '' : 's'} · atualizada {timeAgo(issue.updatedAt)}
            </p>
          </div>
          <section>
            <h4>Descrição</h4>
            <p className="fx-p pre">{desc || 'Sem descrição.'}</p>
          </section>
          {crit.length > 0 && (
            <section>
              <h4>Critérios de aceite</h4>
              <ul className="checklist">
                {crit.map((c, i) => (
                  <li key={i} className={c.done ? 'ok' : ''}>
                    <span className="ck">{c.done ? '✓' : ''}</span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notes.length > 0 && (
            <section>
              <h4>Notas vinculadas</h4>
              <div className="fx-notes">
                {notes.map(({ note, nodeId: nid }) => (
                  <button key={note!.id} className="fx-note" onClick={() => openFocus(nid!)}>
                    <b>{note!.title}</b>
                    <span>{firstLine(note!.body)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section>
            <h4>Agentes</h4>
            <p className="lab" style={{ margin: 0 }}>
              Nenhum agente ainda. Iniciar agentes a partir da issue chega na próxima fase.
            </p>
          </section>
          <section>
            <h4>Discussão</h4>
            {error ? (
              <p className="lab" style={{ margin: 0, color: 'var(--bad)' }}>
                {error}
              </p>
            ) : !comments ? (
              <p className="lab" style={{ margin: 0 }}>
                Carregando…
              </p>
            ) : !comments.length ? (
              <p className="lab" style={{ margin: 0 }}>
                Sem comentários ainda.
              </p>
            ) : (
              <div className="thread">
                {comments.map((c) => (
                  <div className="cm" key={c.id}>
                    <span className={`av${c.isAgent ? ' bot' : ''}`}>
                      {c.isAgent ? <IconAgent /> : initials(c.author)}
                    </span>
                    <div>
                      <div className="cm-h">
                        <b>{c.author}</b>
                        {c.isAgent && <span className="badge info">agente</span>}
                        <time dateTime={c.createdAt}>{timeAgo(c.createdAt)}</time>
                      </div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      <div className="f-foot">
        <div className="f-sugg">
          <button
            type="button"
            onClick={() => {
              const id = noteFor(nodeId);
              if (id) openFocus(id);
            }}
          >
            + Nota para esta issue
          </button>
          <button type="button" onClick={() => window.open(issue.webUrl, '_blank', 'noopener,noreferrer')}>
            Abrir no GitLab
          </button>
        </div>
        <div className="f-hint">Comentar pelo canvas chega na Fase 3 · Esc fecha</div>
      </div>
    </div>
  );
}

function NoteDoc({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const note = useStore((s) => (node ? s.notes[node.refId] : undefined));
  const links = useStore((s) =>
    s.noteLinks
      .filter((l) => node && l.noteId === node.refId && s.nodes[l.targetNodeId])
      .map((l) => {
        const t = s.nodes[l.targetNodeId]!;
        return t.type === 'issue' ? `#${s.issues[t.refId]?.iid ?? ''}` : 'item';
      })
      .join(', '),
  );
  const updateNote = useStore((s) => s.updateNote);
  const flushNote = useStore((s) => s.flushNote);
  const body = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = setTimeout(() => body.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [nodeId]);
  if (!note) return null;
  const count = links ? links.split(', ').length : 0;
  return (
    <div className="f-main">
      <Head
        icon={
          <span className="ico note">
            <IconNote />
          </span>
        }
        name="Nota"
        sub={count ? `Vinculada a ${links}` : 'Sem vínculos'}
        status={
          <span className="badge">
            {count} vínculo{count === 1 ? '' : 's'}
          </span>
        }
        onClose={onClose}
      />
      <div className="f-body doc note-doc">
        <div className="note-ed">
          <input
            value={note.title}
            aria-label="Título da nota"
            onChange={(e) => updateNote(note.id, { title: e.target.value })}
            onBlur={(e) => {
              if (!e.target.value.trim()) updateNote(note.id, { title: 'Sem título' });
              flushNote(note.id);
            }}
          />
          <textarea
            ref={body}
            value={note.body}
            aria-label="Texto da nota"
            placeholder="Escreva decisões, regras de negócio, links, trechos de log…"
            onChange={(e) => updateNote(note.id, { body: e.target.value })}
            onBlur={() => flushNote(note.id)}
          />
          <p className="lab" style={{ margin: 0 }}>
            As alterações salvam sozinhas. Agentes vinculados leem de novo quando você sai do campo.
          </p>
        </div>
      </div>
    </div>
  );
}
