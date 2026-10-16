import { useMemo, useState, type ReactNode } from 'react';
import { detectRepos, type Issue } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { noteFor, startIssueAgent } from '../actions.ts';
import { AgentPanel, AgentTreeItem } from '../agents/AgentPanel.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { IconAgent, IconFit, IconIssue, IconMr, IconNote, IconRepo } from '../icons.tsx';
import { checklist, descriptionWithoutChecklist, firstLine, isRedLabel } from '../lib/format.ts';
import { askFixPipeline } from '../actions.ts';
import { DiffStat, MrBadge, mrFailed, mrReady } from '../mrs/mr-ui.tsx';
import { agentNodeOf, liveAgents, useStore } from '../state/store.ts';
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
  const open = !!(node || panel);

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
        <h3>{i.title}</h3>
        <div>
          <button className="btn primary" onClick={() => s.openFocus(nodeId)}>
            Expandir issue
          </button>
        </div>
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
      <IssueStart key={nodeId} nodeId={nodeId} issue={i} />
      <div className="row2">
        <a className="btn" href={i.webUrl} target="_blank" rel="noreferrer noopener">
          Abrir no GitLab
        </a>
        <button className="btn plain danger" onClick={() => s.removeNode(nodeId)}>
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
  return (
    <>
      <div className="grp">
        <h4>Repositórios afetados</h4>
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
          <select
            className="field"
            style={{ width: 'auto' }}
            aria-label="Profundidade de sub-agentes"
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          >
            {!orch && <option value={0}>Sem sub-agentes</option>}
            <option value={1}>Até 1 nível</option>
            <option value={2}>Até 2 níveis</option>
            <option value={3}>Até 3 níveis</option>
          </select>
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
      <button
        className="btn primary"
        style={{ justifyContent: 'center', padding: 10 }}
        onClick={() => startIssueAgent(nodeId, extra, { repos, maxDepth: depth, openMr })}
      >
        {orch ? `Iniciar orquestrador (${repos.length} repositórios)` : 'Iniciar agente'}
      </button>
    </>
  );
}

const NO_PROJECTS: never[] = [];

function MrPanel(nodeId: string): [ReactNode, ReactNode] {
  const s = useStore.getState();
  const n = s.nodes[nodeId]!;
  const m = s.mergeRequests[n.refId];
  if (!m) return ['MR', <p className="lab">Carregando dados do GitLab…</p>];
  const agent = m.agentId ? s.agents[m.agentId] : undefined;
  const agentNode = agent ? agentNodeOf(s, agent.id) : undefined;
  const issue = m.issueRef ? s.issues[m.issueRef] : undefined;
  return [
    <span className="badge mrb">MR !{m.iid}</span>,
    <>
      <div className="grp">
        <h3>{m.title}</h3>
        <div>
          <button className="btn primary" onClick={() => s.openFocus(nodeId)}>
            Ver diff e discussão
          </button>
        </div>
        <dl className="kv">
          <dt>Projeto</dt>
          <dd className="mono">{m.projectPath}</dd>
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
              <dt>Aberto por</dt>
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
          Aprovar e mergear
        </button>
      )}
      {mrFailed(m) && agent && (
        <button className="btn" style={{ justifyContent: 'center' }} onClick={() => askFixPipeline(m.ref)}>
          Pedir correção a {agent.name}
        </button>
      )}
      <p className="lab" style={{ margin: 0 }}>
        O status do pipeline atualiza sozinho a cada 30 segundos. Agentes nunca fazem merge.
      </p>
      <div className="row2">
        <a className="btn" href={m.webUrl} target="_blank" rel="noreferrer noopener">
          Abrir no GitLab
        </a>
        <button className="btn plain danger" onClick={() => s.removeNode(nodeId)}>
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
        <h3>{nt.title}</h3>
        {nt.body ? (
          <Markdown className="desc" compact>
            {nt.body}
          </Markdown>
        ) : (
          <p className="desc">Sem texto ainda. Escreva direto no cartão.</p>
        )}
      </div>
      <div>
        <button className="btn primary" onClick={() => s.openFocus(nodeId)}>
          Expandir nota
        </button>
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
        <select
          className="field"
          value=""
          aria-label="Vincular a"
          onChange={(e) => e.target.value && s.linkNote(nt.id, e.target.value)}
        >
          <option value="">Vincular a…</option>
          {targets.map((t) => {
            const i = s.issues[t.refId];
            const a = t.type === 'agent' ? s.agents[t.refId] : undefined;
            return (
              <option key={t.id} value={t.id}>
                {a
                  ? `${a.name} · ${a.title.slice(0, 50)}`
                  : i
                    ? `Issue #${i.iid} · ${i.title.slice(0, 50)}`
                    : t.refId}
              </option>
            );
          })}
        </select>
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
      <div className="row2">
        <button className="btn plain danger" onClick={() => s.removeNode(nodeId)}>
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
        Atalhos: Ctrl/⌘ + B mostra ou esconde a barra lateral, Delete remove o item selecionado, Ctrl/⌘ + Z
        desfaz, Ctrl/⌘ + scroll dá zoom.
      </p>
    </>
  );
}

const AUTOS = [
  {
    when: 'Pipeline falhou',
    then: 'Criar agente para corrigir',
    desc: 'Lê o log do job e corrige no mesmo branch.',
  },
  {
    when: 'Comentário de revisão no MR',
    then: 'Enviar ao agente autor',
    desc: 'O agente que abriu o MR ajusta e responde.',
  },
  {
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
    when: 'Label agent-ready na issue',
    then: 'Iniciar agentes',
    desc: 'A issue entra no canvas e os agentes começam sozinhos.',
  },
];

function Automations() {
  const automations = useStore((s) => s.settings?.automations);
  const toggle = async (on: boolean) => {
    try {
      useStore.getState().setSettings(await api.setAutomations({ handoff: on }));
    } catch (e) {
      useStore.getState().showToast(e instanceof ApiError ? e.message : 'Falha ao salvar a automação.');
    }
  };
  return (
    <>
      <h3>Quando acontecer…</h3>
      <p className="desc" style={{ color: 'var(--muted)', margin: 0 }}>
        Regras que reagem a eventos e colocam agentes para trabalhar. A nota de passagem já funciona; as
        outras chegam na Fase 6.
      </p>
      <div className="rules">
        {AUTOS.map((r) => {
          const live = r.key === 'handoff';
          return (
            <label className="rule" key={r.when} style={live ? undefined : { cursor: 'default' }}>
              <span className="rule-tx">
                <span className="rule-when">{r.when}</span>
                <span className="rule-then">→ {r.then}</span>
                <span className="lab">{r.desc}</span>
              </span>
              <span className="switch">
                <input
                  type="checkbox"
                  disabled={!live}
                  checked={live ? !!automations?.handoff : false}
                  onChange={(e) => live && void toggle(e.target.checked)}
                  aria-label={r.when}
                />
                <i />
              </span>
            </label>
          );
        })}
      </div>
    </>
  );
}
