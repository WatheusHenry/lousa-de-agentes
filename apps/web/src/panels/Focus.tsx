import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { NoteBody } from '../components/NoteBody.tsx';
import type { IssueComment, MergeRequest, MrDiffFile } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { noteFor, startFromCard } from '../actions.ts';
import { AgentTreeItem } from '../agents/AgentPanel.tsx';
import { nodeScreenRect, reducedMotion } from '../canvas/viewport.ts';
import { IconAgent, IconIssue, IconMr, IconNote, IconSearch } from '../icons.tsx';
import {
  checklist,
  descriptionWithoutChecklist,
  firstLine,
  initials,
  isRedLabel,
  repoName,
  timeAgo,
} from '../lib/format.ts';
import { agentNodeOf, mrNodeOf, useStore } from '../state/store.ts';
import {
  DiffStat,
  isLocalMr,
  MrBadge,
  mrName,
  mrNum,
  mrReady,
  PipelineStages,
  PublishButton,
} from '../mrs/mr-ui.tsx';
import { AgentLines, useStickToBottom } from '../agents/AgentLines.tsx';
import { AutoModeToggle, autoModeKey } from '../agents/AutoModeToggle.tsx';
import { isBlank, reposText, roleLabel, statusLabel, statusTone, SUGGESTIONS } from '../agents/agent-ui.ts';

const NO_PROJECTS: never[] = [];

/** Qualquer item abre grande, com o fundo do canvas borrado. Issue vira documento; nota vira editor. */
export function Focus() {
  const focusId = useStore((s) => s.focusId);
  const node = useStore((s) => (s.focusId ? s.nodes[s.focusId] : undefined));
  const sideHidden = useStore((s) => s.sideHidden);
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
    // o painel da direita some no foco: o documento usa a largura toda
    right: wide ? 12 : 8,
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
        {shown?.type === 'agent' && <AgentDoc nodeId={shown.id} onClose={closeAnimated} />}
        {shown?.type === 'mr' && <MrDoc nodeId={shown.id} onClose={closeAnimated} />}
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
  const agentsById = useStore((s) => s.agents);
  const issueAgents = useMemo(
    () =>
      Object.values(nodes)
        .filter((n) => n.type === 'agent')
        .map((n) => agentsById[n.refId])
        .filter((a) => !!a && a.issueRef === node?.refId) as NonNullable<(typeof agentsById)[string]>[],
    [nodes, agentsById, node?.refId],
  );
  const thread = useThread(issue ? issue.ref : null, () => api.comments(issue!.projectId, issue!.iid));
  const commentIssue = useStore((s) => s.commentIssue);
  const mergeRequests = useStore((s) => s.mergeRequests);
  const issueMrs = useMemo(
    () =>
      Object.values(mergeRequests).filter(
        (m) =>
          m.issueRef === node?.refId &&
          Object.values(nodes).some((n) => n.type === 'mr' && n.refId === m.ref),
      ),
    [mergeRequests, nodes, node?.refId],
  );

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
            {desc ? (
              <Markdown className="fx-p" baseUrl={issue.webUrl.replace(/\/-\/issues\/\d+$/, '')}>
                {desc}
              </Markdown>
            ) : (
              <p className="fx-p">Sem descrição.</p>
            )}
          </section>
          {crit.length > 0 && (
            <section>
              <h4>Critérios de aceite</h4>
              <ul className="checklist">
                {crit.map((c, i) => (
                  <li key={i} className={c.done ? 'ok' : ''}>
                    <span className="ck">{c.done ? '✓' : ''}</span>
                    <Markdown inline>{c.text}</Markdown>
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
            {issueAgents.length ? (
              <ul className="tree">
                {issueAgents.map((a) => (
                  <AgentTreeItem key={a.id} agent={a} />
                ))}
              </ul>
            ) : (
              <p className="lab" style={{ margin: 0 }}>
                Nenhum agente ainda. Use "Iniciar agente" abaixo.
              </p>
            )}
          </section>
          {issueMrs.length > 0 && (
            <section>
              <h4>Merge requests</h4>
              <div className="links">
                {issueMrs.map((m) => (
                  <div className="lk" key={m.ref}>
                    <span className="ico mr">
                      <IconMr />
                    </span>
                    <span>
                      <b>{mrNum(m)}</b> {m.projectPath.split('/').pop()}
                    </span>
                    <MrBadge mr={m} />
                    <button
                      className="btn sm plain"
                      onClick={() => {
                        const n = mrNodeOf(useStore.getState(), m.ref);
                        if (n) openFocus(n.id);
                      }}
                    >
                      Abrir
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section>
            <h4>Discussão</h4>
            <Thread {...thread} baseUrl={issue.webUrl.replace(/\/-\/issues\/\d+$/, '')} />
          </section>
        </div>
      </div>
      <div className="f-foot">
        <div className="f-sugg">
          <button
            type="button"
            onClick={() => {
              const id = startFromCard(nodeId);
              if (id) openFocus(id);
            }}
          >
            Iniciar agente
          </button>
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
        <CommentBox
          placeholder={`Comentar na issue #${issue.iid}`}
          onSend={(body) => commentIssue(issue.ref, body)}
        />
        <div className="f-hint">O comentário vai para o GitLab com o seu usuário · Esc fecha</div>
      </div>
    </div>
  );
}

/** Discussão do GitLab, recarregada quando o bridge avisa que mudou (thread.changed). */
function useThread(ref: string | null, load: () => Promise<IssueComment[]>) {
  const version = useStore((s) => (ref ? (s.threadVersion[ref] ?? 0) : 0));
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ref) return;
    let alive = true;
    // ao trocar de item, limpa; ao recarregar o mesmo, mantém a lista até chegar a nova
    if (lastRef.current !== ref) setComments(null);
    lastRef.current = ref;
    setError(null);
    load()
      .then((c) => alive && setComments(c))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : 'Falha ao carregar a discussão.'));
    return () => {
      alive = false;
    };
  }, [ref, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { comments, error };
}

function Thread({
  comments,
  error,
  baseUrl,
}: {
  comments: IssueComment[] | null;
  error: string | null;
  /** URL do projeto, para links relativos nos comentários. */
  baseUrl?: string;
}) {
  if (error)
    return (
      <p className="lab" style={{ margin: 0, color: 'var(--bad)' }}>
        {error}
      </p>
    );
  if (!comments)
    return (
      <p className="lab" style={{ margin: 0 }}>
        Carregando…
      </p>
    );
  if (!comments.length)
    return (
      <p className="lab" style={{ margin: 0 }}>
        Sem comentários ainda.
      </p>
    );
  return (
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
            <Markdown className="cm-body" baseUrl={baseUrl}>
              {c.body}
            </Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Campo de comentário do foco de issue e MR. */
function CommentBox({ placeholder, onSend }: { placeholder: string; onSend(body: string): void }) {
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <form
      className="f-comp"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target;
          t.style.height = 'auto';
          t.style.height = Math.min(t.scrollHeight, 160) + 'px';
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="send" aria-label="Comentar">
        ↑
      </button>
    </form>
  );
}

/** Número de cada linha do diff (novo arquivo para + e contexto, antigo para -). */
function numbered(lines: string[]) {
  let oldN = 0;
  let newN = 0;
  return lines.map((l) => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      return { l, kind: 'hunk' as const, n: null };
    }
    if (l[0] === '+') return { l, kind: 'add' as const, n: newN++ };
    if (l[0] === '-') return { l, kind: 'del' as const, n: oldN++ };
    oldN++;
    return { l, kind: 'ctx' as const, n: newN++ };
  });
}

/** Trecho com as ocorrências da busca marcadas (sem diferenciar maiúsculas). */
function marked(text: string, q: string): ReactNode {
  if (!q) return text;
  const low = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) {
    out.push(text.slice(from, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    from = i + q.length;
  }
  out.push(text.slice(from));
  return out;
}

const fileName = (f: MrDiffFile) => (f.renamedFile ? `${f.oldPath} → ${f.newPath}` : f.newPath);

/**
 * Diff do MR: lista dos arquivos para pular direto a um deles, arquivos recolhíveis e busca
 * no texto das mudanças (Enter vai à próxima ocorrência, Shift + Enter à anterior).
 */
function DiffView({
  files,
  mr,
  agentName,
}: {
  files: MrDiffFile[];
  mr: MergeRequest;
  agentName: string | null;
}) {
  const parsed = useMemo(() => files.map((f) => numbered(f.diff.replace(/\n$/, '').split('\n'))), [files]);
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const [closed, setClosed] = useState<Set<number>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  // ocorrências: [arquivo, linha]; a linha do cabeçalho do hunk não conta
  const hits = useMemo(() => {
    const out: [number, number][] = [];
    if (!q) return out;
    parsed.forEach((lines, fi) =>
      lines.forEach((x, li) => {
        if (x.kind !== 'hunk' && x.l.slice(1).toLowerCase().includes(q)) out.push([fi, li]);
      }),
    );
    return out;
  }, [parsed, q]);
  const at = hits.length ? Math.min(cur, hits.length - 1) : -1;
  const current = at >= 0 ? hits[at]! : null;

  useEffect(() => {
    if (!current) return;
    // ocorrência num arquivo recolhido: abre o arquivo antes de rolar até ela
    if (closed.has(current[0])) {
      setClosed((c) => new Set([...c].filter((i) => i !== current[0])));
      return;
    }
    box.current
      ?.querySelector(`[data-at="${current[0]}-${current[1]}"]`)
      ?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [current?.[0], current?.[1], closed]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (d: number) => hits.length && setCur((at + d + hits.length) % hits.length);
  const toggle = (i: number) =>
    setClosed((c) => {
      const n = new Set(c);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const goFile = (i: number) => {
    if (closed.has(i)) toggle(i);
    requestAnimationFrame(() =>
      box.current
        ?.querySelector(`[data-file="${i}"]`)
        ?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }),
    );
  };
  const perFile = (fi: number) => hits.filter((h) => h[0] === fi).length;

  return (
    <div className="dv" ref={box}>
      <div className="dv-bar">
        <div className="dv-search">
          <IconSearch size={13} />
          <input
            value={query}
            placeholder="Buscar nas mudanças"
            aria-label="Buscar nas mudanças"
            onChange={(e) => {
              setQuery(e.target.value);
              setCur(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {q && (
            <span className="dv-count" aria-live="polite">
              {hits.length ? `${at + 1} de ${hits.length}` : 'nada'}
            </span>
          )}
          <button
            type="button"
            className="btn plain icon xs"
            aria-label="Ocorrência anterior"
            disabled={!hits.length}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn plain icon xs"
            aria-label="Próxima ocorrência"
            disabled={!hits.length}
            onClick={() => step(1)}
          >
            ↓
          </button>
        </div>
        {files.length > 1 && (
          <button
            type="button"
            className="btn sm plain"
            onClick={() => setClosed(closed.size ? new Set() : new Set(files.map((_, i) => i)))}
          >
            {closed.size ? 'Abrir todos' : 'Recolher todos'}
          </button>
        )}
      </div>
      {files.length > 1 && (
        <ol className="dv-files" aria-label="Arquivos do MR">
          {files.map((f, i) => {
            const lines = parsed[i]!;
            const n = perFile(i);
            return (
              <li key={i}>
                <button
                  type="button"
                  className={q && !n ? 'dim' : ''}
                  onClick={() => goFile(i)}
                  title={fileName(f)}
                >
                  <span className="dv-fn">{fileName(f)}</span>
                  {q ? (
                    <small>{n}</small>
                  ) : (
                    <DiffStat
                      add={lines.filter((x) => x.kind === 'add').length}
                      del={lines.filter((x) => x.kind === 'del').length}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="dv-list">
        {files.map((f, i) => (
          <DiffFile
            key={`${f.oldPath}:${f.newPath}`}
            index={i}
            f={f}
            lines={parsed[i]!}
            mr={mr}
            agentName={agentName}
            q={q}
            current={current && current[0] === i ? current[1] : null}
            open={!closed.has(i)}
            onToggle={() => toggle(i)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Linhas de um diff unificado, com as classes do protótipo. Clicar numa linha abre um
 * comentário ali mesmo, que vai para o agente autor (e, se marcado, para o MR no GitLab).
 */
function DiffFile({
  index,
  f,
  lines,
  mr,
  agentName,
  q,
  current,
  open,
  onToggle,
}: {
  index: number;
  f: MrDiffFile;
  lines: ReturnType<typeof numbered>;
  mr: MergeRequest;
  agentName: string | null;
  q: string;
  current: number | null;
  open: boolean;
  onToggle(): void;
}) {
  const add = lines.filter((x) => x.kind === 'add').length;
  const del = lines.filter((x) => x.kind === 'del').length;
  const [at, setAt] = useState<number | null>(null);
  return (
    <div className={`diff${open ? '' : ' shut'}`} data-file={index}>
      <button type="button" className="diff-h" aria-expanded={open} onClick={onToggle}>
        <span className="diff-caret" aria-hidden="true">
          ▾
        </span>
        <span className="diff-name">
          {fileName(f)}
          {f.newFile ? ' (novo)' : f.deletedFile ? ' (removido)' : ''}
        </span>
        <DiffStat add={add} del={del} />
      </button>
      {open && (
        <div className="diff-b">
          {lines.map((x, i) => {
            const hit = !!q && x.kind !== 'hunk' && x.l.slice(1).toLowerCase().includes(q);
            return (
              <div key={i}>
                <div
                  className={`dl ${x.kind}${x.n !== null ? ' can' : ''}${at === i ? ' on' : ''}${hit ? ' hit' : ''}${current === i ? ' cur' : ''}`}
                  data-at={hit ? `${index}-${i}` : undefined}
                  title={x.n !== null ? 'Clique para comentar nesta linha' : undefined}
                  onClick={() => x.n !== null && setAt(at === i ? null : i)}
                >
                  <span className="dn">{x.n ?? ''}</span>
                  {hit ? (
                    <>
                      {x.l[0]}
                      {marked(x.l.slice(1), q)}
                    </>
                  ) : (
                    x.l || ' '
                  )}
                </div>
                {at === i && (
                  <LineComment
                    mr={mr}
                    agentName={agentName}
                    where={`${f.newPath}${x.kind === 'del' ? ' (linha removida)' : ''}:${x.n}`}
                    code={x.l}
                    onDone={() => setAt(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Comentário numa linha do diff: para o agente autor e, se marcado, para o MR no GitLab. */
function LineComment({
  mr,
  agentName,
  where,
  code,
  onDone,
}: {
  mr: MergeRequest;
  agentName: string | null;
  where: string;
  code: string;
  onDone(): void;
}) {
  const [text, setText] = useState('');
  const local = isLocalMr(mr);
  const [publish, setPublish] = useState(!agentName && !local);
  const forwards = useStore((s) => !!s.settings?.automations.reviewComments);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    const st = useStore.getState();
    const quote = `\`${where}\`\n\n\`\`\`diff\n${code}\n\`\`\`\n\n${body}`;
    if (publish) st.commentMr(mr.ref, quote);
    // publicado no MR com a automação ligada, o comentário já chega ao autor por ela
    if (agentName && mr.agentId && !(publish && forwards))
      st.messageAgent(
        mr.agentId,
        `Comentário do usuário no MR !${mr.iid}, em ${quote}\n\nAjuste se fizer sentido, rode os testes, faça commit e chame open_merge_request para enviar ao MR.`,
      );
    st.showToast(
      agentName
        ? `Comentário enviado a ${agentName}${publish ? ' e publicado no MR' : ''}.`
        : 'Comentário publicado no MR.',
      { label: 'Ok', run: () => {} },
    );
    onDone();
  };
  return (
    <div className="lc">
      <textarea
        className="field"
        autoFocus
        rows={3}
        value={text}
        placeholder={agentName ? `O que ${agentName} deve mudar aqui?` : 'Comentário sobre esta linha'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <div className="lc-foot">
        {agentName && !local && (
          <label>
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Também
            publicar no MR (GitLab)
          </label>
        )}
        <span className="spacer" />
        <button type="button" className="btn sm plain" onClick={onDone}>
          Cancelar
        </button>
        <button type="button" className="btn sm primary" disabled={!text.trim()} onClick={send}>
          {agentName ? `Enviar a ${agentName}` : 'Comentar no MR'}
        </button>
      </div>
    </div>
  );
}

function MrDoc({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const mr = useStore((s) => (node ? s.mergeRequests[node.refId] : undefined));
  const agent = useStore((s) => (mr?.agentId ? s.agents[mr.agentId] : undefined));
  const issue = useStore((s) => (mr?.issueRef ? s.issues[mr.issueRef] : undefined));
  const openFocus = useStore((s) => s.openFocus);
  const commentMr = useStore((s) => s.commentMr);
  const mergeMr = useStore((s) => s.mergeMr);
  const refreshMr = useStore((s) => s.refreshMr);
  const thread = useThread(mr ? mr.ref : null, () => api.mrComments(mr!.ref));
  const [files, setFiles] = useState<MrDiffFile[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!mr) return;
    let alive = true;
    setDiffError(null);
    api
      .mrDiff(mr.ref)
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setDiffError(e instanceof ApiError ? e.message : 'Falha ao carregar o diff.'));
    return () => {
      alive = false;
    };
  }, [mr?.ref, mr?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mr) return null;
  const local = isLocalMr(mr);
  const repo = mr.projectPath.split('/').pop();
  const description = mr.description.replace(/\n*_Aberto por .+ no Agent Canvas\._\s*$/, '').trim();

  return (
    <div className="f-main">
      <Head
        icon={
          <span className="ico mr">
            <IconMr />
          </span>
        }
        name={mrName(mr)}
        sub={`${repo} · ${mr.sourceBranch}`}
        status={<MrBadge mr={mr} />}
        onClose={onClose}
      />
      <div className="f-body doc">
        <div className="fx">
          <div className="fx-head">
            <div className="tags">
              <span className="badge repo">{repo}</span>
              <span className="badge">
                {mr.sourceBranch} → {mr.targetBranch}
              </span>
            </div>
            <h2 className="fx-title">{mr.title}</h2>
            <p className="fx-meta">
              {agent ? `${local ? 'Feito' : 'Aberto'} por ${agent.name}` : 'Aberto pelo canvas'}
              {issue ? ` · fecha #${issue.iid}` : ''} · <DiffStat add={mr.additions} del={mr.deletions} /> ·
              atualizado {timeAgo(mr.updatedAt)}
            </p>
          </div>
          {description && (
            <section>
              <h4>Descrição</h4>
              <Markdown className="fx-p" baseUrl={mr.webUrl.replace(/\/-\/merge_requests\/\d+$/, '')}>
                {description}
              </Markdown>
            </section>
          )}
          {!local && (
            <section>
              <h4>Pipeline</h4>
              <PipelineStages mr={mr} />
            </section>
          )}
          <section>
            <h4>
              Mudanças{files ? ` · ${files.length} arquivo${files.length === 1 ? '' : 's'}` : ''}
              {files?.length ? <small className="h4-hint"> · clique numa linha para comentar</small> : null}
            </h4>
            {diffError ? (
              <p className="lab" style={{ margin: 0, color: 'var(--bad)' }}>
                {diffError}
              </p>
            ) : !files ? (
              <p className="lab" style={{ margin: 0 }}>
                Carregando…
              </p>
            ) : !files.length ? (
              <p className="lab" style={{ margin: 0 }}>
                Sem mudanças para mostrar.
              </p>
            ) : (
              <DiffView files={files} mr={mr} agentName={agent?.name ?? null} />
            )}
          </section>
          {local ? (
            <section>
              <h4>Repositório local</h4>
              <p className="fx-p">
                Sem MR no GitLab: você revisa o diff aqui, comenta numa linha ou escreve abaixo para{' '}
                {agent?.name ?? 'o agente'} ajustar, e faz o merge em <code>{mr.targetBranch}</code> no seu
                clone. Se quiser revisão no remoto, envie o branch e abra o MR/PR por lá.
              </p>
            </section>
          ) : (
            <section>
              <h4>Discussão</h4>
              <Thread {...thread} baseUrl={mr.webUrl.replace(/\/-\/merge_requests\/\d+$/, '')} />
            </section>
          )}
        </div>
      </div>
      <div className="f-foot">
        <div className="f-sugg">
          {mrReady(mr) && (
            <button type="button" onClick={() => mergeMr(mr.ref)}>
              {local ? `Mergear em ${mr.targetBranch}` : 'Aprovar e mergear'}
            </button>
          )}
          {agent && (
            <button
              type="button"
              onClick={() => {
                const n = agentNodeOf(useStore.getState(), agent.id);
                if (n) openFocus(n.id);
              }}
            >
              Abrir {agent.name}
            </button>
          )}
          <button type="button" onClick={() => refreshMr(mr.ref)}>
            Atualizar status
          </button>
          {local ? (
            <PublishButton mr={mr} className="" />
          ) : (
            <button type="button" onClick={() => window.open(mr.webUrl, '_blank', 'noopener,noreferrer')}>
              Abrir no GitLab
            </button>
          )}
        </div>
        {local ? (
          agent && (
            <>
              <CommentBox
                placeholder={`Mensagem para ${agent.name} sobre esta revisão`}
                onSend={(body) =>
                  useStore
                    .getState()
                    .messageAgent(
                      agent.id,
                      `Sobre a sua entrega (revisão #${mr.iid}, branch ${mr.sourceBranch}): ${body}\n\nAjuste, rode os testes, faça commit e chame open_merge_request para atualizar a revisão.`,
                    )
                }
              />
              <div className="f-hint">A mensagem vai direto para {agent.name} · Esc fecha</div>
            </>
          )
        ) : (
          <>
            <CommentBox
              placeholder={`Comentar no MR !${mr.iid}`}
              onSend={(body) => commentMr(mr.ref, body)}
            />
            <div className="f-hint">O comentário vai para o GitLab com o seu usuário · Esc fecha</div>
          </>
        )}
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
          <NoteBody
            key={nodeId}
            className="note-body"
            autoFocus
            value={note.body}
            placeholder="Escreva decisões, regras de negócio, links, trechos de log…"
            onChange={(b) => updateNote(note.id, { body: b })}
            onCommit={() => flushNote(note.id)}
          />
          <p className="lab" style={{ margin: 0 }}>
            Aceita Markdown: clique no texto para editar. As alterações salvam sozinhas. Agentes vinculados
            leem de novo quando você sai do campo.
          </p>
        </div>
      </div>
    </div>
  );
}

const NO_EVENTS: never[] = [];

/** Agente em foco: a conversa grande, com sugestões e o campo de mensagem. */
function AgentDoc({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const agent = useStore((s) => (node ? s.agents[node.refId] : undefined));
  const events = useStore((s) => (node ? (s.agentEvents[node.refId] ?? NO_EVENTS) : NO_EVENTS));
  const projects = useStore((s) => s.settings?.projects ?? NO_PROJECTS);
  const message = useStore((s) => s.messageAgent);
  const [text, setText] = useState('');
  const [raw, setRaw] = useState<string[] | null>(null);
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(raw ? raw.length : events.length);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [nodeId]);
  if (!agent) return null;

  const send = (t: string) => {
    if (!t.trim()) return;
    message(agent.id, t.trim());
    setText('');
    if (input.current) input.current.style.height = '';
  };
  const toggleRaw = async () => {
    if (raw) return setRaw(null);
    try {
      setRaw(await api.rawEvents(agent.id));
    } catch (e) {
      setRaw([e instanceof ApiError ? e.message : 'Falha ao carregar a saída bruta.']);
    }
  };

  return (
    <div className="f-main">
      <Head
        icon={
          <span className="lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        }
        name={agent.name}
        sub={`${roleLabel(agent)} · ${reposText(agent, projects)}${agent.branch ? ` · ${agent.branch}` : ''}`}
        status={
          <>
            <button
              className="btn plain sm"
              onClick={toggleRaw}
              title="Linhas do stream-json, para depuração"
            >
              {raw ? 'Saída estruturada' : 'Saída bruta'}
            </button>
            <span className={`badge ${statusTone(agent.status)}`}>
              <span className="d" />
              {statusLabel(agent.status)}
            </span>
          </>
        }
        onClose={onClose}
      />
      <div className="f-body" ref={ref} onScroll={onScroll}>
        {raw ? (
          <pre className="raw">{raw.join('\n') || '(nada ainda)'}</pre>
        ) : isBlank(agent) && events.length === 0 ? (
          <div className="empty-term">
            <b>Agente em branco</b>
            <ul>
              <li>
                Escolha o repositório no painel da direita, ou arraste um repositório ou uma issue para cima
                do agente.
              </li>
              <li>Escreva a primeira instrução abaixo. O agente começa por ela.</li>
            </ul>
          </div>
        ) : (
          <AgentLines agent={agent} events={events} />
        )}
      </div>
      <div className="f-foot">
        {!isBlank(agent) && (
          <div className="f-sugg">
            {SUGGESTIONS.map((sg) => (
              <button key={sg} type="button" onClick={() => send(sg)}>
                {sg}
              </button>
            ))}
          </div>
        )}
        <form
          className="f-comp"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={text}
            placeholder={
              isBlank(agent) ? `Primeira instrução para ${agent.name}` : `Converse com ${agent.name}`
            }
            aria-label={`Mensagem para ${agent.name}`}
            onChange={(e) => {
              setText(e.target.value);
              const t = e.target;
              t.style.height = 'auto';
              t.style.height = Math.min(t.scrollHeight, 160) + 'px';
            }}
            onKeyDown={(e) => {
              if (autoModeKey(e, agent)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <button className="send" aria-label="Enviar">
            ↑
          </button>
        </form>
        <div className="f-hint f-hint-row">
          <AutoModeToggle agent={agent} full />
          <span>Enter envia · Shift + Enter quebra linha · Esc fecha</span>
        </div>
      </div>
    </div>
  );
}
