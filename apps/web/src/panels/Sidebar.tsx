import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Issue } from '@agent-canvas/shared';
import { addIssue, newAgentAt } from '../actions.ts';
import { isLive } from '../agents/agent-ui.ts';
import {
  IconAgent,
  IconDrag,
  IconExpand,
  IconIssue,
  IconLocate,
  IconPlus,
  IconRepo,
  IconSearch,
} from '../icons.tsx';
import { clock, isBug, isP1, repoName } from '../lib/format.ts';
import { useStore, type CanvasState, type Tab } from '../state/store.ts';

/** Itens da aba Ações: permissões pendentes e agentes esperando instrução. */
export function actionsCount(s: CanvasState): number {
  let n = Object.keys(s.approvals).length;
  for (const node of Object.values(s.nodes)) {
    const a = node.type === 'agent' ? s.agents[node.refId] : undefined;
    if (a && (a.status === 'idle' || a.status === 'done' || a.status === 'error')) n++;
  }
  return n;
}

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
  const actionCount = useStore((s) => actionsCount(s));

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
              {t.id === 'actions' && actionCount > 0 && <span className="cnt">{actionCount}</span>}
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
  const agents = useStore((s) => s.agents);

  // agentes ativos por issue (só os que estão no canvas)
  const activity = useMemo(() => {
    const m = new Map<string, { active: number; waiting: boolean }>();
    for (const n of Object.values(nodes)) {
      const a = n.type === 'agent' ? agents[n.refId] : undefined;
      if (!a?.issueRef || !isLive(a)) continue;
      const cur = m.get(a.issueRef) ?? { active: 0, waiting: false };
      m.set(a.issueRef, { active: cur.active + 1, waiting: cur.waiting || a.status === 'waiting' });
    }
    return m;
  }, [nodes, agents]);

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
      .filter((i) => (filter === 'bug' ? isBug(i) : filter === 'agents' ? activity.has(i.ref) : true));
    const onCanvas = (i: Issue) => onRefs.has(i.ref);
    return { on: list.filter(onCanvas), off: list.filter((i) => !onCanvas(i)), total: list.length };
  }, [refs, issues, nodes, query, filter, activity]);

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
            <IssueRow key={i.ref} issue={i} onCanvas state={activity.get(i.ref)} />
          ))}
        </>
      )}
      <div className="grp-h">
        <span>Backlog</span>
        <span className="cnt">{off.length}</span>
      </div>
      {off.map((i) => (
        <IssueRow key={i.ref} issue={i} onCanvas={false} state={activity.get(i.ref)} />
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

function IssueRow({
  issue: i,
  onCanvas,
  state,
}: {
  issue: Issue;
  onCanvas: boolean;
  state: { active: number; waiting: boolean } | undefined;
}) {
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
        {state?.waiting ? (
          <span className="badge warn" title="Algum agente aguarda você">
            <span className="d" />
            Você
          </span>
        ) : state ? (
          <span className="badge info live" title={`${state.active} agentes ativos`}>
            <span className="d" />
            {state.active}
          </span>
        ) : null}
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
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const nodes = useStore((s) => s.nodes);
  const policies = useStore((s) => s.policies);
  const st = useStore.getState();
  const pending = Object.values(approvals).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const idle = Object.values(nodes)
    .filter((n) => n.type === 'agent')
    .map((n) => ({ node: n, agent: agents[n.refId] }))
    .filter(
      (x) =>
        x.agent && (x.agent.status === 'idle' || x.agent.status === 'done' || x.agent.status === 'error'),
    );
  const nodeOf = (agentId: string) =>
    Object.values(nodes).find((n) => n.type === 'agent' && n.refId === agentId);

  const policiesBlock = (
    <>
      <div className="grp-h">
        <span>Sempre permitidos</span>
        <span className="cnt">{policies.length}</span>
      </div>
      {policies.length ? (
        <div className="pol">
          {policies.map((p) => (
            <span className="chipx" key={p.id}>
              <code>{p.pattern}</code>
              <button
                className="x"
                aria-label={`Remover regra ${p.pattern}`}
                onClick={() => st.removePolicy(p.id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="tip">
          Use "Sempre permitir" num pedido para liberar aquele comando para todos os agentes.
        </p>
      )}
    </>
  );

  if (!pending.length && !idle.length)
    return (
      <>
        <div className="empty-act">
          <span className="ico agent">
            <IconAgent />
          </span>
          <b>Nada esperando você</b>
          <span>Quando um agente pedir permissão ou terminar um turno, aparece aqui.</span>
        </div>
        {policiesBlock}
      </>
    );

  return (
    <>
      {pending.length > 0 && (
        <>
          <div className="grp-h">
            <span>Permissões</span>
            <span className="cnt">{pending.length}</span>
            {pending.length > 1 && (
              <button
                className="btn sm plain"
                style={{ marginLeft: 'auto' }}
                onClick={() => pending.forEach((p) => st.decideApproval(p.id, 'allow'))}
              >
                Permitir todos
              </button>
            )}
          </div>
          {pending.map((p) => {
            const a = agents[p.agentId];
            const n = nodeOf(p.agentId);
            const repo = st.settings?.projects.find((x) => x.id === a?.repos[0]);
            return (
              <div className="act-card" key={p.id}>
                <div className="act-top">
                  <span className="sd waiting" />
                  <b>{a?.name ?? 'agente'}</b>
                  <span className="lab">{repo?.name ?? ''}</span>
                  {n && (
                    <button
                      className="btn plain icon xs"
                      aria-label={`Abrir ${a?.name}`}
                      title="Abrir agente"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => st.openFocus(n.id)}
                    >
                      <IconExpand />
                    </button>
                  )}
                </div>
                <code className="act-cmd">
                  {p.toolName}({p.summary})
                </code>
                <div className="act-btns">
                  <button className="btn sm primary" onClick={() => st.decideApproval(p.id, 'allow')}>
                    Permitir
                  </button>
                  <button className="btn sm" onClick={() => st.decideApproval(p.id, 'deny')}>
                    Negar
                  </button>
                  <button
                    className="btn sm plain"
                    title={`Grava a regra ${p.suggestedRule} e libera os pedidos iguais`}
                    onClick={() => st.decideApproval(p.id, 'allow', true)}
                  >
                    Sempre permitir
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="grp-h">
            <span>Aguardando instrução</span>
            <span className="cnt">{idle.length}</span>
          </div>
          {idle.map(({ node, agent }) => (
            <div className="act-card" key={node.id}>
              <div className="act-top">
                <span className={`sd ${agent!.status === 'idle' ? 'idle' : agent!.status}`} />
                <b>{agent!.name}</b>
                <span className="lab">
                  {agent!.status === 'idle'
                    ? 'sem instrução'
                    : agent!.status === 'error'
                      ? 'parou com erro'
                      : 'turno concluído'}
                </span>
              </div>
              <div className="act-btns">
                <button className="btn sm" onClick={() => st.openFocus(node.id)}>
                  {agent!.status === 'idle' ? 'Escrever instrução' : 'Ver e responder'}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {policiesBlock}
    </>
  );
}

function ReposTab() {
  const settings = useStore((s) => s.settings)!;
  const query = useStore((s) => s.query).toLowerCase();
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const list = settings.projects.filter((p) => !query || p.pathWithNamespace.toLowerCase().includes(query));
  const agents = useStore((s) => s.agents);
  const nodes = useStore((s) => s.nodes);
  const activeByRepo = new Map<number, number>();
  for (const n of Object.values(nodes)) {
    const a = n.type === 'agent' ? agents[n.refId] : undefined;
    if (a && isLive(a) && a.repos[0] !== undefined)
      activeByRepo.set(a.repos[0], (activeByRepo.get(a.repos[0]) ?? 0) + 1);
  }
  return (
    <>
      <div className="grp-h">
        <span>Repositórios</span>
        <span className="cnt">{list.length}</span>
      </div>
      {list.map((p) => (
        <div
          className="iss"
          key={p.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', `repo:${p.id}`);
            e.dataTransfer.effectAllowed = 'copy';
          }}
        >
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
            {(activeByRepo.get(p.id) ?? 0) > 0 && (
              <span className="badge info live" title={`${activeByRepo.get(p.id)} agentes ativos`}>
                <span className="d" />
                {activeByRepo.get(p.id)}
              </span>
            )}
            <button
              className="btn plain icon xs"
              aria-label={`Novo agente em ${p.name}`}
              title="Novo agente"
              onClick={() => newAgentAt(undefined, { repos: [p.id] })}
            >
              <IconAgent />
            </button>
          </div>
        </div>
      ))}
      <p className="tip">
        <IconDrag /> Arraste um repositório para o canvas para criar um agente, ou solte em cima de um agente
        em branco.
      </p>
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
