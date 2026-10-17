import { useMemo, useState, type ReactNode } from 'react';
import { detectRepos, type Automations as AutomationsT, type Issue } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { noteFor, startIssueAgent } from '../actions.ts';
import { AgentPanel, AgentTreeItem } from '../agents/AgentPanel.tsx';
import { AgentSettingsForm } from './AgentSettingsForm.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { Select } from '../components/Select.tsx';
import { IconAgent, IconExpand, IconFit, IconIssue, IconMr, IconNote, IconRepo } from '../icons.tsx';
import { checklist, descriptionWithoutChecklist, firstLine, isRedLabel } from '../lib/format.ts';
import { fixPipeline } from '../actions.ts';
import { DiffStat, isLocalMr, MrBadge, mrFailed, mrName, mrReady, PublishButton } from '../mrs/mr-ui.tsx';
import { activeFixer, agentNodeOf, liveAgents, useStore } from '../state/store.ts';
import { focusNode } from '../canvas/viewport.ts';

/** Painel flutuante da direita: detalhes do item selecionado, ajuda ou automações. */
export function Inspector() {
  const panel = useStore((s) => s.panel);
  const node = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  // os painéis leem o estado direto; estas assinaturas fazem o painel redesenhar quando ele muda
  useStore((s) => s.issues);
  useStore((s) => s.notes);
  useStore((s) => s.noteLinks);
  useStore((s) => s.nodes);
  useStore((s) => s.agents);
  useStore((s) => s.mergeRequests);
  const close = () => {
    useStore.getState().select(null);
    useStore.getState().setPanel(null);
  };
  // no modo foco o painel some (o foco já mostra o item inteiro) e volta ao fechar
  const focused = useStore((s) => !!s.focusId);
  const open = !!(node || panel) && !focused;

  let kicker: ReactNode = null;
  let body: ReactNode = null;
  if (node?.type === 'issue') {
    [kicker, body] = IssuePanel(node.id);
  } else if (node?.type === 'note') {
    [kicker, body] = NotePanel(node.id);
  } else if (node?.type === 'agent') {
    kicker = 'Agente';
    body = <AgentPanel agentId={node.refId} nodeId={node.id} />;
  } else if (node?.type === 'mr') {
    [kicker, body] = MrPanel(node.id);
  } else if (panel === 'help') {
    kicker = 'Como funciona';
    body = <Help />;
  } else if (panel === 'auto') {
    kicker = 'Automações';
    body = <Automations />;
  }

  return (
    <aside className={`insp${open ? ' open' : ''}`} inert={!open} aria-label="Detalhes">
      <div className="insp-top">
        <span className="k">{kicker}</span>
        <button className="btn plain icon" aria-label="Fechar painel" onClick={close}>
          ✕
        </button>
      </div>
      <div className="insp-body">{body}</div>
    </aside>
  );
}

function IssuePanel(nodeId: string): [ReactNode, ReactNode] {
  const s = useStore.getState();
  const n = s.nodes[nodeId]!;
  const i = s.issues[n.refId];
  if (!i) return ['Issue', <p className="lab">Carregando dados do GitLab…</p>];
  const desc = descriptionWithoutChecklist(i.description);
  const crit = checklist(i.description);
  const notes = s.noteLinks
    .filter((l) => l.targetNodeId === nodeId)
    .map((l) => s.notes[l.noteId])
    .filter((x) => !!x);
  const agents = liveAgents(s).filter((a) => a.issueRef === i.ref);
  return [
    <span className="badge issue">Issue #{i.iid}</span>,
    <>
      <div className="grp">
        <TitleRow title={i.title} label="Expandir issue" onExpand={() => s.openFocus(nodeId)} />
        {desc ? (
          <Markdown className="desc" compact baseUrl={i.webUrl.replace(/\/-\/issues\/\d+$/, '')}>
            {desc.length > 600 ? desc.slice(0, 600) + '…' : desc}
          </Markdown>
        ) : (
          <p className="lab">Sem descrição.</p>
        )}
        {crit.length > 0 && (
          <p className="lab" style={{ margin: 0 }}>
            {crit.filter((c) => c.done).length} de {crit.length} critérios de aceite marcados
          </p>
        )}
        <dl className="kv">
          <dt>Projeto</dt>
          <dd className="mono">{i.projectPath}</dd>
          <dt>Autor</dt>
          <dd>@{i.author}</dd>
          <dt>Comentários</dt>
          <dd>{i.commentCount}</dd>
          {i.labels.length > 0 && (
            <>
              <dt>Labels</dt>
              <dd>
                <span className="tags">
                  {i.labels.map((l) => (
                    <span key={l} className={`badge ${isRedLabel(l) ? 'issue' : ''}`}>
                      {l}
                    </span>
                  ))}
                </span>
              </dd>
            </>
          )}
        </dl>
      </div>
      <MergeOrder issueRef={i.ref} />
      <IssueStart key={nodeId} nodeId={nodeId} issue={i} />
      <div className="grp">
        <h4>Notas</h4>
        {notes.length ? (
          <div className="opts">
            {notes.map((nt) => (
              <label className="opt" key={nt.id}>
                <IconNote /> {nt.title}
                <small>{firstLine(nt.body).slice(0, 28)}</small>
              </label>
            ))}
          </div>
        ) : (
          <p className="lab" style={{ margin: 0 }}>
            Nenhuma nota vinculada a esta issue.
          </p>
        )}
        <div>
          <button className="btn sm" onClick={() => noteFor(nodeId)}>
            + Nota para esta issue
          </button>
        </div>
      </div>
      {agents.length > 0 && (
        <div className="grp">
          <h4>Agentes</h4>
          <ul className="tree">
            {agents.map((a) => (
              <AgentTreeItem key={a.id} agent={a} />
            ))}
          </ul>
        </div>
      )}
      <div className="row2">
        <a className="btn" href={i.webUrl} target="_blank" rel="noreferrer noopener">
          Abrir no GitLab
        </a>
        <ArchiveButton nodeId={nodeId} issueRef={i.ref} />
      </div>
      <div className="foot-danger">
        <button className="btn plain danger sm" onClick={() => s.removeNode(nodeId)}>
          Remover do canvas
        </button>
      </div>
    </>,
  ];
}

/** Repositórios afetados, autonomia e início: um repositório gera um agente; vários, um orquestrador. */
function IssueStart({ nodeId, issue }: { nodeId: string; issue: Issue }) {
  const projects = useStore((s) => s.settings?.projects ?? NO_PROJECTS);
  const detected = useMemo(() => detectRepos(issue, projects), [issue, projects]);
  const [repos, setRepos] = useState<number[]>(detected);
  const [depth, setDepth] = useState(repos.length > 1 ? 1 : 0);
  const [openMr, setOpenMr] = useState(true);
  const [extra, setExtra] = useState('');
  const toggle = (id: number) => {
    const next = repos.includes(id) ? repos.filter((r) => r !== id) : [...repos, id];
    if (!next.length) return;
    // orquestrador precisa de pelo menos um nível para criar os agentes
    if (next.length > 1 && depth === 0) setDepth(1);
    setRepos(next);
  };
  const orch = repos.length > 1;
  // a issue já tem agentes: começar outro trabalho deixa de ser a ação principal
  const hasAgents = useStore((s) => Object.values(s.agents).some((a) => a.issueRef === issue.ref));
  const names = repos.map((id) => projects.find((p) => p.id === id)?.name).filter(Boolean);
  const summary = [
    orch ? `${names.length} repositórios` : (names[0] ?? 'repositório da issue'),
    depth === 0 ? 'sem sub-agentes' : `sub-agentes até ${depth} nível${depth > 1 ? 's' : ''}`,
    openMr ? 'abre MR ao final' : 'sem MR',
  ].join(' · ');
  return (
    <>
      <div className="grp">
        <h4>Iniciar trabalho</h4>
        <p className="lab" style={{ margin: 0 }}>
          Repositórios afetados
        </p>
        <div className="opts">
          {projects.map((p) => (
            <label className="opt" key={p.id}>
              <input type="checkbox" checked={repos.includes(p.id)} onChange={() => toggle(p.id)} />{' '}
              <IconRepo /> {p.name}
              {detected.includes(p.id) && (
                <small>{p.id === issue.projectId ? 'da issue' : 'citado na issue'}</small>
              )}
            </label>
          ))}
        </div>
        {orch && (
          <p className="lab" style={{ margin: 0 }}>
            Com mais de um repositório, um orquestrador divide o trabalho: um agente por repositório.
          </p>
        )}
      </div>
      <div className="grp">
        <h4>Autonomia</h4>
        <div className="row2">
          <Select
            className="auto"
            label="Profundidade de sub-agentes"
            value={String(depth)}
            onChange={(v) => setDepth(Number(v))}
            options={[
              ...(orch ? [] : [{ value: '0', label: 'Sem sub-agentes' }]),
              { value: '1', label: 'Até 1 nível' },
              { value: '2', label: 'Até 2 níveis' },
              { value: '3', label: 'Até 3 níveis' },
            ]}
          />
          <label className="opt" style={{ border: 0, padding: 0 }}>
            <input type="checkbox" checked={openMr} onChange={(e) => setOpenMr(e.target.checked)} /> Abrir MR
            ao final
          </label>
        </div>
      </div>
      <div className="grp">
        <h4>Instruções extras</h4>
        <textarea
          className="field"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Opcional. Ex.: não alterar o schema do banco"
        />
        <p className="lab" style={{ margin: 0 }}>
          O agente recebe a issue, os comentários e as notas vinculadas em .agent-canvas/context.md.
        </p>
      </div>
      <div className="insp-cta">
        <span className="lab">{summary}</span>
        <button
          className={`btn${hasAgents ? '' : ' primary'}`}
          onClick={() => startIssueAgent(nodeId, extra, { repos, maxDepth: depth, openMr })}
        >
          {hasAgents ? 'Iniciar de novo: ' : 'Iniciar '}
          {orch ? `orquestrador (${repos.length} repositórios)` : 'agente'}
        </button>
      </div>
    </>
  );
}

const NO_PROJECTS: never[] = [];

/**
 * MRs abertos da issue para mergear em sequência: na ordem do plano do orquestrador quando
 * houver (o usuário ajusta com ↑↓), o bridge espera o pipeline de cada um antes do próximo.
 */
function MergeOrder({ issueRef }: { issueRef: string }) {
  const mrs = useStore((s) => s.mergeRequests);
  const agents = useStore((s) => s.agents);
  const progress = useStore((s) => s.merges[issueRef]);
  const open = Object.values(mrs).filter((m) => m.issueRef === issueRef && m.state === 'opened');
  // ordem do plano: passos do agente raiz da issue, cada um com o MR do agente responsável
  const planned: string[] = [];
  for (const a of Object.values(agents))
    if (a.issueRef === issueRef && a.depth === 0)
      for (const it of a.plan ?? []) {
        const m = open.find((x) => x.agentId && it.agentId === x.agentId);
        if (m && !planned.includes(m.ref)) planned.push(m.ref);
      }
  const fallback = open
    .filter((m) => !planned.includes(m.ref))
    .sort((a, b) => a.iid - b.iid)
    .map((m) => m.ref);
  const suggested = [...planned, ...fallback];
  const [order, setOrder] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const running = progress && (progress.state === 'waiting' || progress.state === 'merging');
  const refs = running ? progress.refs : (order ?? suggested).filter((r) => open.some((m) => m.ref === r));
  for (const r of suggested) if (!refs.includes(r) && !running) refs.push(r);
  const shown = running ? progress.refs : refs;
  if (shown.length < 2 && !progress) return null;

  const move = (k: number, d: -1 | 1) => {
    const next = [...refs];
    [next[k], next[k + d]] = [next[k + d]!, next[k]!];
    setOrder(next);
  };
  const icon = (ref: string, k: number) => {
    if (progress?.merged.includes(ref)) return '✓';
    if (running && progress.index === k) return progress.state === 'merging' ? '↻' : '⏳';
    return String(k + 1);
  };
  return (
    <div className="grp merge-order">
      <h4>Merge requests da issue</h4>
      <ol>
        {shown.map((ref, k) => {
          const m = mrs[ref];
          return (
            <li key={ref} className={progress?.merged.includes(ref) ? 'ok' : ''}>
              <span className="mo-n" aria-hidden="true">
                {icon(ref, k)}
              </span>
              <span className="mo-t">
                <b>!{m?.iid}</b> {m?.projectPath.split('/').pop()}
                <small>{m?.title}</small>
              </span>
              {m && <MrBadge mr={m} />}
              {!running && (
                <span className="mo-mv">
                  <button
                    className="btn plain icon xs"
                    aria-label="Subir"
                    disabled={k === 0}
                    onClick={() => move(k, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="btn plain icon xs"
                    aria-label="Descer"
                    disabled={k === refs.length - 1}
                    onClick={() => move(k, 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {progress && (
        <p className={`lab mo-st ${progress.state}`} style={{ margin: 0 }}>
          {progress.message}
        </p>
      )}
      {running ? (
        <div className="act-btns">
          <button className="btn sm" onClick={() => useStore.getState().cancelMerge(issueRef)}>
            Cancelar sequência
          </button>
        </div>
      ) : refs.length >= 2 && confirming ? (
        <div className="callout">
          <span>
            Mergear {refs.length} MRs nesta ordem? O app espera o pipeline de cada um passar antes do próximo
            e para na primeira falha.
          </span>
          <div className="act-btns">
            <button
              className="btn sm primary"
              onClick={() => {
                setConfirming(false);
                useStore.getState().startMerge(issueRef, refs);
              }}
            >
              Mergear na ordem
            </button>
            <button className="btn sm plain" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        refs.length >= 2 && (
          <div className="act-btns">
            <button className="btn sm" onClick={() => setConfirming(true)}>
              Mergear na ordem ({refs.length})
            </button>
            {planned.length > 0 && <span className="lab">Ordem do plano do orquestrador</span>}
          </div>
        )
      )}
    </div>
  );
}

/** Arquivar: some do canvas com agentes, MRs e notas; volta pela aba Issues. */
function ArchiveButton({ nodeId, issueRef }: { nodeId: string; issueRef: string }) {
  const busy = useStore((s) =>
    Object.values(s.agents).find(
      (a) => a.issueRef === issueRef && ['running', 'waiting', 'coordinating', 'queued'].includes(a.status),
    ),
  );
  return (
    <button
      className="btn"
      disabled={!!busy}
      title={
        busy
          ? `${busy.name} ainda está trabalhando. Pare ou espere para arquivar.`
          : 'Tira do canvas a issue com os agentes, MRs e notas dela. Volta pela aba Issues → Arquivadas.'
      }
      onClick={() => useStore.getState().archiveIssue(nodeId)}
    >
      Arquivar
    </button>
  );
}

/** Título do painel com o botão de expandir (abre o modo foco), como o ↗ dos cartões. */
function TitleRow({ title, label, onExpand }: { title: string; label: string; onExpand(): void }) {
  return (
    <div className="insp-title">
      <h3>{title}</h3>
      <button className="btn plain icon" aria-label={label} title={label} onClick={onExpand}>
        <IconExpand />
      </button>
    </div>
  );
}

function MrPanel(nodeId: string): [ReactNode, ReactNode] {
  const s = useStore.getState();
  const n = s.nodes[nodeId]!;
  const m = s.mergeRequests[n.refId];
  if (!m) return ['MR', <p className="lab">Carregando…</p>];
  const agent = m.agentId ? s.agents[m.agentId] : undefined;
  const agentNode = agent ? agentNodeOf(s, agent.id) : undefined;
  const issue = m.issueRef ? s.issues[m.issueRef] : undefined;
  const local = isLocalMr(m);
  const clone = local ? s.settings?.clones.find((c) => c.projectId === m.projectId)?.path : null;
  return [
    <span className="badge mrb">{mrName(m)}</span>,
    <>
      <div className="grp">
        <TitleRow title={m.title} label="Ver diff" onExpand={() => s.openFocus(nodeId)} />
        <div>
          <button className="btn sm" onClick={() => s.openFocus(nodeId)}>
            {local ? 'Ver diff' : 'Ver diff e discussão'}
          </button>
        </div>
        <dl className="kv">
          <dt>{local ? 'Repositório' : 'Projeto'}</dt>
          <dd className="mono">{local ? m.projectPath.split('/').pop() : m.projectPath}</dd>
          <dt>Branch</dt>
          <dd className="mono">
            {m.sourceBranch} → {m.targetBranch}
          </dd>
          <dt>Status</dt>
          <dd>
            <MrBadge mr={m} />
          </dd>
          <dt>Mudanças</dt>
          <dd>
            <DiffStat add={m.additions} del={m.deletions} />
          </dd>
          {agent && (
            <>
              <dt>{local ? 'Feito por' : 'Aberto por'}</dt>
              <dd>
                {agentNode ? (
                  <button className="btn sm" onClick={() => focusNode(agentNode.id)}>
                    {agent.name}
                  </button>
                ) : (
                  agent.name
                )}
              </dd>
            </>
          )}
          {issue && (
            <>
              <dt>Fecha</dt>
              <dd>#{issue.iid}</dd>
            </>
          )}
        </dl>
      </div>
      {mrReady(m) && (
        <button
          className="btn primary"
          style={{ justifyContent: 'center', padding: 10 }}
          onClick={() => s.mergeMr(m.ref)}
        >
          {local ? `Mergear em ${m.targetBranch}` : 'Aprovar e mergear'}
        </button>
      )}
      {mrFailed(m) && agent && <FixButton mrRef={m.ref} />}
      {local ? (
        <>
          <p className="lab" style={{ margin: 0 }}>
            Repositório local: o merge acontece no seu clone{clone ? ` (${clone})` : ''}, sem mexer em
            arquivos que você não salvou. Agentes nunca fazem merge nem push.
          </p>
          <div className="row2">
            <PublishButton mr={m} />
          </div>
        </>
      ) : (
        <>
          <p className="lab" style={{ margin: 0 }}>
            O status do pipeline atualiza sozinho a cada 30 segundos. Agentes nunca fazem merge.
          </p>
          <div className="row2">
            <a className="btn" href={m.webUrl} target="_blank" rel="noreferrer noopener">
              Abrir no GitLab
            </a>
          </div>
        </>
      )}
      <div className="foot-danger">
        <button className="btn plain danger sm" onClick={() => s.removeNode(nodeId)}>
          Remover do canvas
        </button>
      </div>
    </>,
  ];
}

function NotePanel(nodeId: string): [ReactNode, ReactNode] {
  const s = useStore.getState();
  const n = s.nodes[nodeId]!;
  const nt = s.notes[n.refId];
  if (!nt) return ['Nota', null];
  const links = s.noteLinks.filter((l) => l.noteId === nt.id && s.nodes[l.targetNodeId]);
  const linked = new Set(links.map((l) => l.targetNodeId));
  const targets = Object.values(s.nodes).filter(
    (x) => (x.type === 'issue' || x.type === 'agent') && !linked.has(x.id),
  );
  const label = (id: string) => {
    const t = s.nodes[id];
    if (t?.type === 'agent') return s.agents[t.refId]?.name ?? 'Agente';
    const i = t && s.issues[t.refId];
    return i ? `Issue #${i.iid}` : 'Item';
  };
  return [
    <span className="badge" style={{ background: 'var(--note-soft)', color: 'var(--note)' }}>
      Nota
    </span>,
    <>
      <div className="grp">
        <TitleRow title={nt.title} label="Expandir nota" onExpand={() => s.openFocus(nodeId)} />
        {nt.body ? (
          <Markdown className="desc" compact>
            {nt.body}
          </Markdown>
        ) : (
          <p className="desc">Sem texto ainda. Escreva direto no cartão.</p>
        )}
      </div>
      <div className="grp">
        <h4>Vinculada a</h4>
        {links.length ? (
          <div className="links">
            {links.map((l) => (
              <div className="lk" key={l.targetNodeId}>
                {s.nodes[l.targetNodeId]?.type === 'agent' ? (
                  <span className="ico agent">
                    <IconAgent />
                  </span>
                ) : (
                  <span className="ico issue">
                    <IconIssue />
                  </span>
                )}
                {label(l.targetNodeId)}
                <button className="btn sm plain" onClick={() => s.unlinkNote(nt.id, l.targetNodeId)}>
                  Remover
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="lab" style={{ margin: 0 }}>
            Nenhum vínculo ainda.
          </p>
        )}
        <Select
          label="Vincular a"
          placeholder="Vincular a…"
          value=""
          onChange={(v) => v && s.linkNote(nt.id, v)}
          options={targets.map((t) => {
            const i = s.issues[t.refId];
            const a = t.type === 'agent' ? s.agents[t.refId] : undefined;
            return {
              value: t.id,
              label: a ? `${a.name} · ${a.title}` : i ? `Issue #${i.iid} · ${i.title}` : t.refId,
            };
          })}
        />
        <p className="lab" style={{ margin: 0 }}>
          Ou arraste o + da nota até uma issue ou um agente no canvas.
        </p>
      </div>
      <div className="grp">
        <h4>Como os agentes usam</h4>
        <p className="desc" style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          Ligada a uma issue, a nota entra no contexto dos próximos agentes iniciados por ela. Quando você
          edita a nota, os agentes ativos leem de novo.
        </p>
      </div>
      <div className="foot-danger">
        <button className="btn plain danger sm" onClick={() => s.removeNode(nodeId)}>
          Excluir nota
        </button>
      </div>
    </>,
  ];
}

function Help() {
  const items: [string, ReactNode, string, string][] = [
    [
      'issue',
      <IconIssue />,
      'Traga issues',
      'Arraste uma issue da lista para o canvas. Ela vira o ponto de partida.',
    ],
    [
      'agent',
      <IconAgent />,
      'Inicie agentes',
      'Se a issue toca vários repositórios, um orquestrador cria um agente por repositório. Cada agente pode abrir sub-agentes até o limite que você definir.',
    ],
    [
      'repo',
      <IconRepo />,
      'Dê contexto',
      'Solte um repositório ou uma issue em cima de um agente, ou escreva no campo de mensagem dele.',
    ],
    [
      'note',
      <IconNote />,
      'Escreva notas',
      'Use + Nota ou dê dois cliques no fundo. Arraste o + da nota até uma issue para usar o texto como contexto.',
    ],
    [
      'doc',
      <IconFit />,
      'Atalhos rápidos',
      'Clique com o botão direito no canvas ou num item para ver as ações mais usadas.',
    ],
    [
      'mr',
      <IconMr />,
      'Revise os MRs',
      'Cada agente abre o MR no próprio repositório. Você pode pedir a outro agente para revisar.',
    ],
  ];
  return (
    <>
      <h3>Orquestre agentes a partir do seu GitLab</h3>
      <ul className="help-list">
        {items.map(([cls, icon, title, text]) => (
          <li key={title}>
            <span className={`ico ${cls}`}>{icon}</span>
            <div>
              <b>{title}</b>
              {text}
            </div>
          </li>
        ))}
      </ul>
      <p className="desc" style={{ color: 'var(--muted)', fontSize: 12.5 }}>
        Ctrl/⌘ + scroll dá zoom no canvas.
      </p>
      <h4 className="help-h">Atalhos de teclado</h4>
      <dl className="keys">
        {KEYS.map(([k, what]) => (
          <div key={what}>
            <dt>
              {k.split(' ').map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

const KEYS: [string, string][] = [
  ['Ctrl/⌘ K', 'Buscar e executar'],
  ['N', 'Novo agente'],
  ['Shift N', 'Nova nota'],
  ['← ↑ → ↓', 'Ir ao item vizinho'],
  ['Enter', 'Abrir o item em foco'],
  ['A', 'Aba Ações'],
  ['F', 'Enquadrar tudo'],
  ['Delete', 'Remover o item'],
  ['Ctrl/⌘ Z', 'Desfazer'],
  ['Ctrl/⌘ B', 'Barra lateral'],
  ['?', 'Esta ajuda'],
];

const AUTOS: { key: keyof AutomationsT; when: string; then: string; desc: string }[] = [
  {
    key: 'fixPipeline',
    when: 'Pipeline falhou',
    then: 'Criar agente para corrigir',
    desc: 'Lê o log do job e corrige no mesmo branch. Até 3 tentativas por MR.',
  },
  {
    key: 'reviewComments',
    when: 'Comentário de revisão no MR',
    then: 'Enviar ao agente autor',
    desc: 'O agente que abriu o MR ajusta e responde.',
  },
  {
    key: 'reviewer',
    when: 'MR aberto por agente',
    then: 'Pedir revisão automática',
    desc: 'Um agente revisor comenta antes de você olhar.',
  },
  {
    key: 'handoff',
    when: 'Agente concluiu',
    then: 'Escrever nota de passagem',
    desc: 'Decisões e arquivos viram contexto para os próximos agentes.',
  },
  {
    key: 'agentReady',
    when: 'Label agent-ready na issue',
    then: 'Iniciar agentes',
    desc: 'A issue entra no canvas e os agentes começam sozinhos.',
  },
];

function Automations() {
  const automations = useStore((s) => s.settings?.automations);
  const toggle = async (key: keyof AutomationsT, on: boolean) => {
    try {
      useStore.getState().setSettings(await api.setAutomations({ [key]: on }));
    } catch (e) {
      useStore.getState().showToast(e instanceof ApiError ? e.message : 'Falha ao salvar a automação.');
    }
  };
  return (
    <>
      <h3>Quando acontecer…</h3>
      <p className="desc" style={{ color: 'var(--muted)', margin: 0 }}>
        Regras que reagem a eventos do GitLab e colocam agentes para trabalhar. O GitLab é consultado a cada
        30 segundos (MRs) e a cada minuto (issues).
      </p>
      <div className="rules">
        {AUTOS.map((r) => (
          <label className="rule" key={r.key}>
            <span className="rule-tx">
              <span className="rule-when">{r.when}</span>
              <span className="rule-then">→ {r.then}</span>
              <span className="lab">{r.desc}</span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                checked={!!automations?.[r.key]}
                onChange={(e) => void toggle(r.key, e.target.checked)}
                aria-label={r.when}
              />
              <i />
            </span>
          </label>
        ))}
      </div>
      <p className="lab" style={{ margin: 0 }}>
        Agentes criados por automação pedem permissão como os outros (menos nos repositórios em modo
        confiança, na aba Repos), e o merge continua sendo seu.
      </p>
      <AgentSettingsForm />
    </>
  );
}

/** Pipeline com falha: cria o agente fix, ou mostra o que já está corrigindo. */
function FixButton({ mrRef }: { mrRef: string }) {
  const fixer = useStore((s) => activeFixer(s, mrRef));
  const node = useStore((s) => (fixer ? agentNodeOf(s, fixer.id) : undefined));
  return fixer ? (
    <button className="btn" style={{ justifyContent: 'center' }} onClick={() => node && focusNode(node.id)}>
      {fixer.name} está corrigindo o pipeline
    </button>
  ) : (
    <button className="btn" style={{ justifyContent: 'center' }} onClick={() => fixPipeline(mrRef)}>
      Criar agente para corrigir
    </button>
  );
}
