import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Issue } from '@agent-canvas/shared';
import { addIssue } from '../actions.ts';
import { IconAgent, IconDrag, IconIssue, IconLocate, IconPlus, IconRepo, IconSearch } from '../icons.tsx';
import { clock, isBug, isP1, repoName } from '../lib/format.ts';
import { useStore, type Tab } from '../state/store.ts';

const TABS: { id: Tab; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'actions', label: 'Ações' },
  { id: 'repos', label: 'Repos' },
  { id: 'feed', label: 'Atividade' },
];

export function Sidebar() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const sideOpen = useStore((s) => s.sideOpen);
  const settings = useStore((s) => s.settings)!;
  const connection = useStore((s) => s.connection);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const idx = TABS.findIndex((t) => t.id === tab);

  // a pílula do segmento só anima quando a aba muda por clique, não na primeira pintura
  const indRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (indRef.current) indRef.current.style.transform = `translateX(${idx * 100}%)`;
  }, [idx]);

  return (
    <aside className={`side${sideOpen ? ' open' : ''}`} id="side" aria-label="Barra lateral">
      <div className="side-h">
        <div className="seg" role="tablist" aria-label="Fontes">
          <span className="seg-ind" ref={indRef} aria-hidden="true" />
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {(tab === 'issues' || tab === 'repos') && (
          <div className="search-w">
            <IconSearch />
            <input
              className="field search"
              type="search"
              placeholder="Buscar"
              aria-label="Buscar"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {tab === 'issues' && (
          <div className="chips" role="group" aria-label="Filtrar issues">
            {(
              [
                ['all', 'Todas'],
                ['bug', 'Bugs'],
                ['agents', 'Com agentes'],
              ] as const
            ).map(([f, label]) => (
              <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="side-b">
        {tab === 'issues' && <IssuesTab />}
        {tab === 'actions' && <ActionsTab />}
        {tab === 'repos' && <ReposTab />}
        {tab === 'feed' && <FeedTab />}
      </div>
      <div className="side-f">
        <span
          className="dot-ok"
          aria-hidden="true"
          style={
            connection === 'open'
              ? undefined
              : { background: 'var(--warn)', boxShadow: '0 0 0 3px var(--warn-soft)' }
          }
        />
        <span className="side-f-t">
          {connection === 'open' ? 'GitLab conectado' : 'Reconectando ao bridge…'}
          <span className="lab">
            {' '}
            · {settings.mode === 'demo' ? 'dados de exemplo' : `@${settings.user?.username ?? ''}`}
          </span>
        </span>
        <button className="link-btn" onClick={() => setSettingsOpen(true)}>
          Configurar
        </button>
      </div>
    </aside>
  );
}

function IssuesTab() {
  const refs = useStore((s) => s.openIssueRefs);
  const issues = useStore((s) => s.issues);
  const nodes = useStore((s) => s.nodes);
  const query = useStore((s) => s.query).toLowerCase();
  const filter = useStore((s) => s.filter);
  const loading = useStore((s) => s.issuesLoading);
  const error = useStore((s) => s.issuesError);

  const { on, off, total } = useMemo(() => {
    const onRefs = new Set(
      Object.values(nodes)
        .filter((n) => n.type === 'issue')
        .map((n) => n.refId),
    );
    const list = refs
      .map((r) => issues[r])
      .filter((i): i is Issue => !!i)
      .filter(
        (i) =>
          !query ||
          `${i.title} ${i.iid} ${i.labels.join(' ')} ${i.projectPath}`.toLowerCase().includes(query),
      )
      .filter((i) => (filter === 'bug' ? isBug(i) : filter === 'agents' ? false : true));
    const onCanvas = (i: Issue) => onRefs.has(i.ref);
    return { on: list.filter(onCanvas), off: list.filter((i) => !onCanvas(i)), total: list.length };
  }, [refs, issues, nodes, query, filter]);

  if (!refs.length && loading) return <p className="tip">Carregando issues do GitLab…</p>;

  return (
    <>
      {error && (
        <p className="tip" role="alert" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}
      {on.length > 0 && (
        <>
          <div className="grp-h">
            <span>No canvas</span>
            <span className="cnt">{on.length}</span>
          </div>
          {on.map((i) => (
            <IssueRow key={i.ref} issue={i} onCanvas />
          ))}
        </>
      )}
      <div className="grp-h">
        <span>Backlog</span>
        <span className="cnt">{off.length}</span>
      </div>
      {off.map((i) => (
        <IssueRow key={i.ref} issue={i} onCanvas={false} />
      ))}
      {!off.length && (
        <p className="tip">
          {filter === 'agents'
            ? 'Nenhuma issue com agentes ainda.'
            : total
              ? 'Todas estas issues já estão no canvas.'
              : 'Nenhuma issue aberta com esse filtro.'}
        </p>
      )}
      <p className="tip">
        <IconDrag /> Arraste para o canvas, ou use o + para adicionar no meio da tela.
      </p>
    </>
  );
}

function IssueRow({ issue: i, onCanvas }: { issue: Issue; onCanvas: boolean }) {
  return (
    <div
      className="iss"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', `issue:${i.ref}`);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => addIssue(i.ref)}
    >
      <span className={`iss-ic${isBug(i) ? ' bug' : ''}`}>
        <IconIssue />
      </span>
      <div className="iss-b">
        <div className="iss-t">{i.title}</div>
        <div className="iss-m">
          <span className="num">#{i.iid}</span>
          {i.labels.some(isP1) && <span className="badge bad">P1</span>}
          <span className="iss-repo">{repoName(i)}</span>
        </div>
      </div>
      <div className="iss-r">
        <button
          className="btn plain icon xs"
          aria-label={`${onCanvas ? 'Mostrar' : 'Adicionar'} issue #${i.iid} ${onCanvas ? 'no' : 'ao'} canvas`}
          title={onCanvas ? 'Mostrar no canvas' : 'Adicionar ao canvas'}
          onClick={() => addIssue(i.ref)}
        >
          {onCanvas ? <IconLocate /> : <IconPlus />}
        </button>
      </div>
    </div>
  );
}

function ActionsTab() {
  return (
    <>
      <div className="empty-act">
        <span className="ico agent">
          <IconAgent />
        </span>
        <b>Nada esperando você</b>
        <span>Quando um agente pedir permissão ou um MR ficar pronto, aparece aqui.</span>
      </div>
      <div className="grp-h">
        <span>Sempre permitidos</span>
        <span className="cnt">0</span>
      </div>
      <p className="tip">
        Use "Sempre permitir" num pedido para liberar aquele comando para todos os agentes.
      </p>
    </>
  );
}

function ReposTab() {
  const settings = useStore((s) => s.settings)!;
  const query = useStore((s) => s.query).toLowerCase();
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const list = settings.projects.filter((p) => !query || p.pathWithNamespace.toLowerCase().includes(query));
  return (
    <>
      <div className="grp-h">
        <span>Repositórios</span>
        <span className="cnt">{list.length}</span>
      </div>
      {list.map((p) => (
        <div className="iss" key={p.id}>
          <span className="iss-ic repo">
            <IconRepo />
          </span>
          <div className="iss-b">
            <div className="iss-t mono-t">{p.name}</div>
            <div className="iss-m">
              <span>{p.description || p.pathWithNamespace}</span>
            </div>
          </div>
          <div className="iss-r">
            <button
              className="btn plain icon xs"
              disabled
              aria-label={`Novo agente em ${p.name}`}
              title="Os agentes chegam na Fase 2"
            >
              <IconAgent />
            </button>
          </div>
        </div>
      ))}
      <p className="tip">
        <button className="link-btn" onClick={() => setSettingsOpen(true)}>
          Escolher projetos
        </button>
      </p>
    </>
  );
}

function FeedTab() {
  const activity = useStore((s) => s.activity);
  if (!activity.length) return <p className="tip">Nada aconteceu ainda.</p>;
  return (
    <ol className="tl">
      {activity.map((f, i) => (
        <li key={`${f.ts}-${i}`}>
          <span className="tl-dot" />
          <div>
            <p>{f.text}</p>
            <time dateTime={f.ts}>{clock(f.ts)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
