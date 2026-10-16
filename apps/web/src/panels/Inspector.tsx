import type { ReactNode } from 'react';
import { noteFor, startIssueAgent } from '../actions.ts';
import { AgentPanel, AgentTreeItem } from '../agents/AgentPanel.tsx';
import { IconAgent, IconFit, IconIssue, IconMr, IconNote, IconRepo } from '../icons.tsx';
import { checklist, descriptionWithoutChecklist, firstLine, isRedLabel, repoName } from '../lib/format.ts';
import { liveAgents, useStore } from '../state/store.ts';

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
          <p className="desc" style={{ whiteSpace: 'pre-wrap' }}>
            {desc.length > 600 ? desc.slice(0, 600) + '…' : desc}
          </p>
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
        <h4>Repositórios afetados</h4>
        <div className="opts">
          <label className="opt">
            <input type="checkbox" checked readOnly disabled /> <IconRepo /> {repoName(i)}
            <small>detectado</small>
          </label>
        </div>
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
      <div className="grp">
        <h4>Instruções extras</h4>
        <textarea className="field" id="c-extra" placeholder="Opcional. Ex.: não alterar o schema do banco" />
        <p className="lab" style={{ margin: 0 }}>
          O agente recebe a issue, os comentários e as notas vinculadas em .agent-canvas/context.md.
        </p>
      </div>
      <button
        className="btn primary"
        style={{ justifyContent: 'center', padding: 10 }}
        onClick={() => {
          const extra = (document.getElementById('c-extra') as HTMLTextAreaElement | null)?.value;
          startIssueAgent(nodeId, extra);
        }}
      >
        Iniciar agente
      </button>
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
        <p className="desc" style={{ whiteSpace: 'pre-wrap' }}>
          {nt.body || 'Sem texto ainda. Escreva direto no cartão.'}
        </p>
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
  return (
    <>
      <h3>Quando acontecer…</h3>
      <p className="desc" style={{ color: 'var(--muted)', margin: 0 }}>
        Regras que reagem a eventos do GitLab e colocam agentes para trabalhar. Elas passam a funcionar junto
        com os agentes, nas próximas fases.
      </p>
      <div className="rules">
        {AUTOS.map((r) => (
          <label className="rule" key={r.when} style={{ cursor: 'default' }}>
            <span className="rule-tx">
              <span className="rule-when">{r.when}</span>
              <span className="rule-then">→ {r.then}</span>
              <span className="lab">{r.desc}</span>
            </span>
            <span className="switch">
              <input type="checkbox" disabled aria-label={r.when} />
              <i />
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
