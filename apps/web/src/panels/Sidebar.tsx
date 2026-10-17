import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Issue, Question, SettingsView } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { addIssue, fixPipeline, newAgentAt } from '../actions.ts';
import { Leftovers } from './Leftovers.tsx';
import { CostPanel } from './CostPanel.tsx';
import { refreshIssues } from '../state/issues.ts';
import { isLive } from '../agents/agent-ui.ts';
import {
  IconAgent,
  IconDrag,
  IconExpand,
  IconIssue,
  IconLocate,
  IconMr,
  IconPlus,
  IconRepo,
  IconSearch,
} from '../icons.tsx';
import { clock, isBug, isP1, remoteLabel, repoName } from '../lib/format.ts';
import { DiffStat, mrFailed, mrNum, mrReady } from '../mrs/mr-ui.tsx';
import { activeFixer, liveMrs, mrNodeOf, useStore, type CanvasState, type Section } from '../state/store.ts';

/**
 * Contador da aba Ações: só o que espera uma decisão sua (permissões, perguntas, MR pronto para
 * merge, pipeline com falha sem agente corrigindo). Agentes parados aparecem na aba, sem contar.
 */
export function actionsCount(s: CanvasState): number {
  let n = Object.keys(s.approvals).length + Object.keys(s.questions).length;
  for (const m of liveMrs(s)) if (mrReady(m) || (mrFailed(m) && !activeFixer(s, m.ref))) n++;
  return n;
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'actions', label: 'Ações' },
  { id: 'issues', label: 'Issues' },
  { id: 'repos', label: 'Repositórios' },
  { id: 'feed', label: 'Atividade' },
];

const readCollapsed = (): Section[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem('ac-side-collapsed') ?? '["feed"]');
    return Array.isArray(v) ? v.filter((x): x is Section => SECTIONS.some((t) => t.id === x)) : [];
  } catch {
    return ['feed'];
  }
};

/** O texto bate com a busca da barra lateral (busca vazia bate com tudo). */
const hit = (q: string, ...parts: (string | number | undefined | null)[]) =>
  !q || parts.join(' ').toLowerCase().includes(q);

export function Sidebar() {
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const sideOpen = useStore((s) => s.sideOpen);
  const settings = useStore((s) => s.settings)!;
  const connection = useStore((s) => s.connection);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const section = useStore((s) => s.section);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const body = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = (id: Section) =>
    setCollapsed((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      try {
        localStorage.setItem('ac-side-collapsed', JSON.stringify(next));
      } catch {
        /* armazenamento indisponível: só não lembra */
      }
      return next;
    });

  // pedido de outra parte da tela (atalho A, aviso, botão): abre a seção e rola até ela
  useEffect(() => {
    if (!section.seq) return;
    if (useStore.getState().query) setQuery('');
    setCollapsed((cur) => cur.filter((x) => x !== section.id));
    requestAnimationFrame(() =>
      body.current
        ?.querySelector(`[data-sec="${section.id}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  }, [section, setQuery]);

  const q = query.trim().toLowerCase();
  // com busca, todas as seções abrem e as sem resultado somem
  const open = (id: Section) => !!q || !collapsed.includes(id);

  return (
    <aside className={`side${sideOpen ? ' open' : ''}`} id="side" aria-label="Barra lateral">
      <div className="side-h">
        <div className="search-w">
          <IconSearch />
          <input
            ref={searchRef}
            className="field search"
            type="search"
            placeholder="Buscar issues, repositórios, ações…"
            aria-label="Buscar na barra lateral"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </div>
      </div>
      <div className="side-b" ref={body}>
        <ActionsSection q={q} open={open('actions')} onToggle={() => toggle('actions')} />
        <IssuesSection q={q} open={open('issues')} onToggle={() => toggle('issues')} />
        <ReposSection q={q} open={open('repos')} onToggle={() => toggle('repos')} />
        <FeedSection q={q} open={open('feed')} onToggle={() => toggle('feed')} />
        {q && <p className="tip side-none">Nada encontrado para "{query.trim()}".</p>}
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
          {connection !== 'open'
            ? 'Reconectando ao bridge…'
            : settings.mode === 'local'
              ? 'Sem GitLab'
              : 'GitLab conectado'}
          <span className="lab">
            {' '}
            ·{' '}
            {settings.mode === 'demo'
              ? 'dados de exemplo'
              : settings.mode === 'local'
                ? 'repositórios locais'
                : `@${settings.user?.username ?? ''}`}
          </span>
        </span>
        <button className="link-btn" onClick={() => setSettingsOpen(true)}>
          Configurar
        </button>
      </div>
    </aside>
  );
}

type SectionProps = { q: string; open: boolean; onToggle(): void };

/** Seção recolhível da barra lateral; o cabeçalho fica preso no topo ao rolar. */
function Sec({
  id,
  count,
  alert,
  tools,
  open,
  onToggle,
  children,
}: {
  id: Section;
  count?: number;
  /** Contador em destaque: algo espera você. */
  alert?: number;
  tools?: ReactNode;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const label = SECTIONS.find((t) => t.id === id)!.label;
  return (
    <section className="sec" data-sec={id} aria-label={label}>
      <div className="sec-h">
        <button className="sec-tg" aria-expanded={open} onClick={onToggle}>
          <span className={`caret${open ? ' open' : ''}`} aria-hidden="true">
            ▸
          </span>
          <span>{label}</span>
          {alert ? (
            <span className="cnt alert" title="Esperando você">
              {alert}
            </span>
          ) : count !== undefined ? (
            <span className="cnt">{count}</span>
          ) : null}
        </button>
        {open && tools}
      </div>
      {open && <div className="sec-b">{children}</div>}
    </section>
  );
}

function IssuesSection({ q, open, onToggle }: SectionProps) {
  const local = useStore((s) => s.settings?.mode === 'local');
  if (local)
    return q ? null : (
      <Sec id="issues" open={open} onToggle={onToggle}>
        <NoGitLab />
      </Sec>
    );
  return <IssueList q={q} open={open} onToggle={onToggle} />;
}

/** Sem GitLab não há issues: o trabalho começa por um agente em branco num repositório local. */
function NoGitLab() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  return (
    <div className="no-gitlab">
      <p className="tip">
        Sem GitLab, não há issues. Crie um agente em branco, escolha um repositório local e diga o que ele
        deve fazer. Quando terminar, você revisa o diff e faz o merge pelo canvas.
      </p>
      <div className="act-btns">
        <button className="btn sm primary" onClick={() => newAgentAt()}>
          <IconAgent /> Novo agente
        </button>
        <button className="btn sm plain" onClick={() => useStore.getState().showSection('repos')}>
          Repositórios
        </button>
      </div>
      <p className="tip">
        Usa GitLab também?{' '}
        <button className="link-btn" onClick={() => setSettingsOpen(true)}>
          Conectar ao GitLab
        </button>
      </p>
    </div>
  );
}

function IssueList({ q, open, onToggle }: SectionProps) {
  const refs = useStore((s) => s.openIssueRefs);
  const issues = useStore((s) => s.issues);
  const nodes = useStore((s) => s.nodes);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const manyProjects = useStore((s) => (s.settings?.projects.filter((p) => !p.local).length ?? 0) > 1);
  const loading = useStore((s) => s.issuesLoading);
  const error = useStore((s) => s.issuesError);
  const agents = useStore((s) => s.agents);
  const chosen = useStore((s) => s.issueProjects);
  const projects = useStore((s) => s.settings?.projects);
  // só os escolhidos que ainda estão nas configurações; nenhum = todos
  const shown = useMemo(() => {
    const ids = chosen.filter((id) => projects?.some((p) => p.id === id));
    return ids.length ? new Set(ids) : null;
  }, [chosen, projects]);

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

  const archived = useStore((s) => s.archived);
  const { on, off, total } = useMemo(() => {
    // arquivadas ficam na seção delas, não no backlog
    const archivedRefs = new Set(archived.map((a) => a.issueRef));
    const onRefs = new Set(
      Object.values(nodes)
        .filter((n) => n.type === 'issue')
        .map((n) => n.refId),
    );
    const list = refs
      .map((r) => issues[r])
      .filter((i): i is Issue => !!i && !archivedRefs.has(i.ref))
      .filter((i) => !shown || shown.has(i.projectId))
      .filter((i) => hit(q, i.title, `#${i.iid}`, i.labels.join(' '), i.projectPath))
      .filter((i) => (filter === 'bug' ? isBug(i) : filter === 'agents' ? activity.has(i.ref) : true));
    const onCanvas = (i: Issue) => onRefs.has(i.ref);
    return { on: list.filter(onCanvas), off: list.filter((i) => !onCanvas(i)), total: list.length };
  }, [refs, issues, nodes, q, filter, activity, shown, archived]);
  const archivedHits = archived.filter((a) => hit(q, a.title, `#${a.iid}`, a.projectPath));
  if (q && !total && !archivedHits.length) return null;

  return (
    <Sec id="issues" count={total} open={open} onToggle={onToggle} tools={<RefreshIssues />}>
      {manyProjects && <ProjectPicker />}
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
      {!refs.length && loading && <p className="tip">Carregando issues do GitLab…</p>}
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
      {(!q || off.length > 0) && (
        <div className="grp-h">
          <span>Backlog</span>
          <span className="cnt">{off.length}</span>
        </div>
      )}
      {off.map((i) => (
        <IssueRow key={i.ref} issue={i} onCanvas={false} state={activity.get(i.ref)} />
      ))}
      {!off.length && !q && !(loading && !refs.length) && (
        <p className="tip">
          {filter === 'agents'
            ? 'Nenhuma issue com agentes ainda.'
            : total
              ? 'Todas estas issues já estão no canvas.'
              : 'Nenhuma issue aberta com esse filtro.'}
        </p>
      )}
      {!q && (
        <p className="tip">
          <IconDrag /> Arraste para o canvas, ou use o + para adicionar no meio da tela.
        </p>
      )}
      <ArchivedList archived={archivedHits} forceOpen={!!q} />
    </Sec>
  );
}

/** Issues arquivadas (com agentes, MRs e notas): restaurar devolve tudo ao canvas. */
function ArchivedList({ archived, forceOpen }: { archived: CanvasState['archived']; forceOpen: boolean }) {
  const [opened, setOpen] = useState(false);
  const open = opened || forceOpen;
  if (!archived.length) return null;
  return (
    <>
      <button className="grp-h grp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Arquivadas</span>
        <span className="cnt">{archived.length}</span>
        <span className="caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open &&
        archived.map((a) => (
          <div className="iss archived" key={a.issueRef}>
            <span className="iss-ic">
              <IconIssue />
            </span>
            <div className="iss-b">
              <div className="iss-t">{a.title}</div>
              <div className="iss-m">
                <span className="mono">#{a.iid}</span> {a.projectPath.split('/').pop()}
                {a.items ? ` · ${a.items} ite${a.items === 1 ? 'm' : 'ns'} junto` : ''}
              </div>
            </div>
            <div className="iss-r">
              <button className="btn sm" onClick={() => useStore.getState().unarchiveIssue(a.issueRef)}>
                Restaurar
              </button>
            </div>
          </div>
        ))}
    </>
  );
}

/** Busca as issues no GitLab na hora, sem esperar a atualização automática. */
function RefreshIssues() {
  const loading = useStore((s) => s.issuesLoading);
  return (
    <button
      className="btn plain icon xs"
      style={{ marginLeft: 'auto' }}
      aria-label="Atualizar issues"
      title="Buscar as issues no GitLab agora"
      disabled={loading}
      onClick={() => void refreshIssues()}
    >
      <span className={loading ? 'spin' : ''}>↻</span>
    </button>
  );
}

/** Escolhe de quais projetos a aba Issues mostra as issues (nenhum marcado = todos). */
function ProjectPicker() {
  const allProjects = useStore((s) => s.settings?.projects ?? EMPTY_PROJECTS);
  // repositórios locais não têm issues
  const projects = useMemo(() => allProjects.filter((p) => !p.local), [allProjects]);
  const chosen = useStore((s) => s.issueProjects);
  const setChosen = useStore((s) => s.setIssueProjects);
  const refs = useStore((s) => s.openIssueRefs);
  const issues = useStore((s) => s.issues);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const byProject = useMemo(() => {
    const m: Record<number, number> = {};
    for (const r of refs) {
      const i = issues[r];
      if (i) m[i.projectId] = (m[i.projectId] ?? 0) + 1;
    }
    return m;
  }, [refs, issues]);
  const valid = chosen.filter((id) => projects.some((p) => p.id === id));
  const all = valid.length === 0 || valid.length === projects.length;
  const isOn = (id: number) => all || valid.includes(id);
  const count = projects.reduce((n, p) => n + (isOn(p.id) ? (byProject[p.id] ?? 0) : 0), 0);

  // fecha ao clicar fora ou com Esc
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = (id: number) => {
    const current = all ? projects.map((p) => p.id) : valid;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    // desmarcar o último volta para todos; marcar todos é o mesmo que nenhum filtro
    setChosen(next.length === projects.length ? [] : next);
  };
  const label = all
    ? 'Todos os projetos'
    : valid.length === 1
      ? projects.find((p) => p.id === valid[0])!.name
      : `${valid.length} de ${projects.length} projetos`;

  return (
    <div className="proj-pick" ref={box}>
      <button
        className="field proj-btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Escolher de quais projetos ver as issues"
      >
        <span className="proj-lab">{label}</span>
        <span className="proj-n">{count}</span>
        <span aria-hidden="true" className="proj-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="proj-menu" role="group" aria-label="Projetos das issues">
          <div className="proj-head">
            <span>Mostrar issues de</span>
            <button className="link-btn" disabled={all} onClick={() => setChosen([])}>
              Todos
            </button>
          </div>
          {projects.map((p) => (
            <div className="proj-row" key={p.id}>
              <label>
                <input type="checkbox" checked={isOn(p.id)} onChange={() => toggle(p.id)} />
                <span className="proj-name" title={p.pathWithNamespace}>
                  {p.pathWithNamespace}
                </span>
                <span className="proj-n">{byProject[p.id] ?? 0}</span>
              </label>
              <button className="link-btn proj-only" onClick={() => setChosen([p.id])} title={`Só ${p.name}`}>
                Só este
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_PROJECTS: never[] = [];
const STOP_ORDER = ['error', 'idle', 'done'];
const STOP_LABEL: Record<string, string> = {
  idle: 'sem instrução',
  error: 'parou com erro',
  done: 'turno concluído',
};

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

function ActionsSection({ q, open, onToggle }: SectionProps) {
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const nodes = useStore((s) => s.nodes);
  const policies = useStore((s) => s.policies);
  const questions = useStore((s) => s.questions);
  const mergeRequests = useStore((s) => s.mergeRequests);
  const st = useStore.getState();
  const waitingCount = useStore((s) => actionsCount(s));
  const repoOf = (agentId: string) =>
    st.settings?.projects.find((x) => x.id === agents[agentId]?.repos[0])?.name ?? '';
  const mrs = useMemo(
    () =>
      Object.values(nodes)
        .filter((n) => n.type === 'mr')
        .map((n) => mergeRequests[n.refId])
        .filter((m) => !!m),
    [nodes, mergeRequests],
  );
  const mrHit = (m: (typeof mrs)[number]) => hit(q, mrNum(m), m.title, m.projectPath);
  const ready = mrs.filter(mrReady).filter(mrHit);
  // com um agente fix trabalhando, a falha não espera você
  const failed = mrs.filter((m) => mrFailed(m) && !activeFixer({ agents }, m.ref)).filter(mrHit);
  const focusMr = (ref: string) => {
    const n = mrNodeOf(useStore.getState(), ref);
    if (n) st.openFocus(n.id);
  };
  const pending = Object.values(approvals)
    .filter((p) => hit(q, agents[p.agentId]?.name, repoOf(p.agentId), p.toolName, p.summary))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const idle = Object.values(nodes)
    .filter((n) => n.type === 'agent')
    .map((n) => ({ node: n, agent: agents[n.refId] }))
    .filter(
      (x) =>
        x.agent && (x.agent.status === 'idle' || x.agent.status === 'done' || x.agent.status === 'error'),
    )
    // erro primeiro, depois quem espera a primeira instrução, depois os concluídos
    .sort((a, b) => STOP_ORDER.indexOf(a.agent!.status) - STOP_ORDER.indexOf(b.agent!.status));
  const nodeOf = (agentId: string) =>
    Object.values(nodes).find((n) => n.type === 'agent' && n.refId === agentId);

  const rules = policies.filter((p) => hit(q, p.pattern));
  const policiesBlock = (q ? rules.length > 0 : true) && (
    <>
      <div className="grp-h">
        <span>Sempre permitidos</span>
        <span className="cnt">{rules.length}</span>
      </div>
      {rules.length ? (
        <div className="pol">
          {rules.map((p) => (
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

  const asks = Object.values(questions)
    .filter((x) => hit(q, agents[x.agentId]?.name, x.text, x.options.join(' ')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = pending.length + idle.length + ready.length + failed.length + asks.length;
  const sec = (children: ReactNode) => (
    <Sec id="actions" count={total} alert={waitingCount} open={open} onToggle={onToggle}>
      {children}
    </Sec>
  );
  if (q && !total && !rules.length) return null;
  if (!total)
    return sec(
      <>
        <div className="empty-act">
          <span className="ico agent">
            <IconAgent />
          </span>
          <b>Nada esperando você</b>
          <span>Quando um agente pedir permissão ou um MR ficar pronto, aparece aqui.</span>
        </div>
        {policiesBlock}
      </>,
    );

  return sec(
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
      {asks.length > 0 && (
        <>
          <div className="grp-h">
            <span>Perguntas</span>
            <span className="cnt">{asks.length}</span>
          </div>
          {asks.map((q) => (
            <QuestionCard
              key={q.id}
              q={q}
              agentName={agents[q.agentId]?.name ?? 'agente'}
              onOpen={() => {
                const n = nodeOf(q.agentId);
                if (n) st.openFocus(n.id);
              }}
            />
          ))}
        </>
      )}
      {ready.length > 0 && (
        <>
          <div className="grp-h">
            <span>Merge requests prontos</span>
            <span className="cnt">{ready.length}</span>
          </div>
          {ready.map((m) => (
            <div className="act-card" key={m.ref}>
              <div className="act-top">
                <span className="ico mr sm">
                  <IconMr />
                </span>
                <b>{mrNum(m)}</b>
                <span className="lab">{m.projectPath.split('/').pop()}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <DiffStat add={m.additions} del={m.deletions} />
                </span>
              </div>
              <p className="act-t">{m.title}</p>
              <div className="act-btns">
                <button className="btn sm primary" onClick={() => st.mergeMr(m.ref)}>
                  Aprovar e mergear
                </button>
                <button className="btn sm" onClick={() => focusMr(m.ref)}>
                  Ver diff
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {failed.length > 0 && (
        <>
          <div className="grp-h">
            <span>Pipelines com falha</span>
            <span className="cnt">{failed.length}</span>
          </div>
          {failed.map((m) => (
            <div className="act-card" key={m.ref}>
              <div className="act-top">
                <span className="ico mr sm">
                  <IconMr />
                </span>
                <b>{mrNum(m)}</b>
                <span className="lab">{m.projectPath.split('/').pop()}</span>
                <span className="badge bad" style={{ marginLeft: 'auto' }}>
                  Falhou
                </span>
              </div>
              <p className="act-t">{m.title}</p>
              <div className="act-btns">
                {m.agentId && agents[m.agentId] && (
                  <button className="btn sm primary" onClick={() => fixPipeline(m.ref)}>
                    Criar agente para corrigir
                  </button>
                )}
                <button className="btn sm" onClick={() => focusMr(m.ref)}>
                  Ver
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="grp-h">
            <span>Agentes parados</span>
            <span className="cnt">{idle.length}</span>
          </div>
          {idle.map(({ node, agent }) => (
            <div className="act-card" key={node.id}>
              <div className="act-top">
                <span className={`sd ${agent!.status === 'idle' ? 'idle' : agent!.status}`} />
                <b>{agent!.name}</b>
                <span className="lab">{STOP_LABEL[agent!.status]}</span>
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
    </>,
  );
}

/** Pergunta de um agente (ask_human): opções sugeridas ou resposta livre. */
function QuestionCard({ q, agentName, onOpen }: { q: Question; agentName: string; onOpen(): void }) {
  const [text, setText] = useState('');
  const answer = (a: string) => a.trim() && useStore.getState().answerQuestion(q.id, a.trim());
  return (
    <div className="act-card">
      <div className="act-top">
        <span className="sd waiting" />
        <b>{agentName}</b>
        <span className="lab">pergunta</span>
        <button
          className="btn plain icon xs"
          aria-label={`Abrir ${agentName}`}
          title="Abrir agente"
          style={{ marginLeft: 'auto' }}
          onClick={onOpen}
        >
          <IconExpand />
        </button>
      </div>
      <p className="act-t">{q.text}</p>
      {q.options.length > 0 && (
        <div className="act-btns">
          {q.options.map((o) => (
            <button key={o} className="btn sm" onClick={() => answer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="act-btns"
        onSubmit={(e) => {
          e.preventDefault();
          answer(text);
        }}
      >
        <input
          className="field"
          style={{ flex: 1, minWidth: 0 }}
          value={text}
          placeholder="Responder com outro texto"
          aria-label={`Resposta para ${agentName}`}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn sm primary" disabled={!text.trim()}>
          Responder
        </button>
      </form>
    </div>
  );
}

function ReposSection({ q, open, onToggle }: SectionProps) {
  const settings = useStore((s) => s.settings)!;
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const list = settings.projects.filter((p) =>
    hit(q, p.pathWithNamespace, settings.clones.find((c) => c.projectId === p.id)?.path),
  );
  const agents = useStore((s) => s.agents);
  const nodes = useStore((s) => s.nodes);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [addingLocal, setAddingLocal] = useState(false);
  const hasGitLab = settings.projects.some((p) => !p.local);
  const activeByRepo = new Map<number, number>();
  for (const n of Object.values(nodes)) {
    const a = n.type === 'agent' ? agents[n.refId] : undefined;
    if (a && isLive(a) && a.repos[0] !== undefined)
      activeByRepo.set(a.repos[0], (activeByRepo.get(a.repos[0]) ?? 0) + 1);
  }
  const cloneOf = (id: number) => settings.clones.find((c) => c.projectId === id);
  const missing = list.filter((p) => !p.local && !cloneOf(p.id)?.path).length;

  /** Chama o bridge; o settings.updated pelo WebSocket atualiza a lista. */
  async function run(key: string, fn: () => Promise<SettingsView>, done?: string) {
    setBusy(key);
    try {
      useStore.getState().setSettings(await fn());
      if (done) useStore.getState().showToast(done, { label: 'Ok', run: () => {} });
      return true;
    } catch (e) {
      useStore.getState().showToast(e instanceof ApiError ? e.message : 'Falha ao falar com o bridge.', {
        label: 'Ok',
        run: () => {},
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (q && !list.length) return null;
  const tools = (
    <>
      {hasGitLab && (
        <button
          className="btn sm plain"
          disabled={!!busy}
          title="Procura os clones de novo, pelo remoto do git"
          onClick={() =>
            run('rescan', api.rescanRepos, missing ? undefined : 'Todos os projetos têm clone local.')
          }
        >
          {busy === 'rescan' ? 'Procurando…' : 'Procurar de novo'}
        </button>
      )}
      <button
        className="btn sm plain"
        disabled={!!busy}
        title="Um repositório git da sua máquina, sem precisar do GitLab"
        onClick={() => setAddingLocal(true)}
      >
        + Local
      </button>
    </>
  );

  return (
    <Sec id="repos" count={list.length} open={open} onToggle={onToggle} tools={tools}>
      {list.map((p) => {
        const c = cloneOf(p.id);
        return (
          <div key={p.id}>
            <div
              className="iss"
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
                <div className="iss-t mono-t">
                  {p.name}
                  {p.local && (
                    <span className="badge local" title={remoteLabel(p.remote)}>
                      local{p.remote === 'github' ? ' · GitHub' : p.remote === 'gitlab' ? ' · GitLab' : ''}
                    </span>
                  )}
                </div>
                <div className="iss-m">
                  {c?.path ? (
                    <span className="mono" title={c.path}>
                      {shortPath(c.path)}
                      {c.manual ? ' · informado' : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--warn, var(--bad))' }}>Sem clone local</span>
                  )}
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
            {!c?.path && !p.local && (
              <div className="act-btns" style={{ margin: '-2px 2px 8px 40px' }}>
                <button
                  className="btn sm"
                  disabled={!!busy}
                  title={`git clone com as suas credenciais (SSH ou HTTPS) em ${settings.reposDir || '~/projetos'}`}
                  onClick={() => run(`clone-${p.id}`, () => api.cloneRepo(p.id), `${p.name} clonado.`)}
                >
                  {busy === `clone-${p.id}` ? 'Clonando…' : 'Clonar'}
                </button>
                <button className="btn sm plain" onClick={() => setPicking(p.id)}>
                  Escolher pasta…
                </button>
              </div>
            )}
            {c?.manual && (
              <p className="tip" style={{ margin: '-4px 2px 8px 40px' }}>
                <button
                  className="link-btn"
                  onClick={() => run(`path-${p.id}`, () => api.setRepoPath(p.id, null))}
                >
                  Voltar para a busca automática
                </button>
              </p>
            )}
            {c?.path && (
              <label
                className="trust-row"
                title="Edições de arquivo e comandos comuns (git local, testes, lint, build, leitura) dentro do worktree do agente passam sem pedir permissão. Push forçado, rede, instalar pacotes e qualquer coisa fora do worktree continuam pedindo."
              >
                <span className="switch sm">
                  <input
                    type="checkbox"
                    checked={settings.trustedRepos.includes(p.id)}
                    disabled={busy === `trust-${p.id}`}
                    onChange={(e) => run(`trust-${p.id}`, () => api.setTrust(p.id, e.target.checked))}
                    aria-label={`Modo confiança em ${p.name}`}
                  />
                  <i />
                </span>
                <span>
                  Modo confiança
                  <small>
                    {settings.trustedRepos.includes(p.id)
                      ? 'edições, testes e commits no worktree sem pedir'
                      : 'pede permissão para cada comando'}
                  </small>
                </span>
              </label>
            )}
            {p.local && (
              <p className="lab" style={{ margin: '-4px 2px 10px 40px', fontSize: 12 }}>
                Agentes partem de <code>{p.defaultBranch ?? 'HEAD'}</code> ·{' '}
                <button
                  className="link-btn"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      `rm-${p.id}`,
                      () => api.removeLocalRepo(p.id),
                      `${p.name} saiu do canvas (a pasta fica).`,
                    )
                  }
                >
                  Tirar do canvas
                </button>
              </p>
            )}
          </div>
        );
      })}
      {picking !== null && (
        <FolderPicker
          title={`Clone de ${settings.projects.find((p) => p.id === picking)?.name ?? ''}`}
          mode="repo"
          start={settings.reposDir}
          onClose={() => setPicking(null)}
          onPick={async (path) => {
            const id = picking;
            setPicking(null);
            await run(`path-${id}`, () => api.setRepoPath(id, path));
          }}
        />
      )}
      {addingLocal && (
        <FolderPicker
          title="Repositório local"
          mode="repo"
          start={settings.reposDir}
          onClose={() => setAddingLocal(false)}
          onPick={async (path) => {
            setAddingLocal(false);
            await run('add-local', () => api.addLocalRepo(path), 'Repositório adicionado.');
          }}
        />
      )}
      {missing > 0 && !q && (
        <p className="tip">
          <span>
            O clone é reconhecido pelo remoto do git, em até 4 níveis de subpastas da pasta dos repositórios.
            Clonar usa a sua chave SSH ou o credential helper do git, nunca o token.
          </span>
        </p>
      )}
      {!q && (
        <>
          <p className="tip">
            <IconDrag /> Arraste um repositório para o canvas para criar um agente, ou solte em cima de um
            agente em branco.
          </p>
          <Leftovers />
          <p className="tip">
            <button className="link-btn" onClick={() => setSettingsOpen(true)}>
              {settings.mode === 'local' ? 'Conectar ao GitLab' : 'Escolher projetos'}
            </button>
          </p>
        </>
      )}
    </Sec>
  );
}

/** /home/ana/projetos/x → ~/projetos/x (o bridge não diz a home; deduz pelo padrão comum). */
const shortPath = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~');

function FeedSection({ q, open, onToggle }: SectionProps) {
  const all = useStore((s) => s.activity);
  const activity = useMemo(() => all.filter((f) => hit(q, f.text)), [all, q]);
  if (q && !activity.length) return null;
  return (
    <Sec id="feed" count={q ? activity.length : undefined} open={open} onToggle={onToggle}>
      {!q && <CostPanel />}
      {!activity.length && <p className="tip">Nada aconteceu ainda.</p>}
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
    </Sec>
  );
}
