import type { Agent } from '@agent-canvas/shared';
import { focusNode } from '../canvas/viewport.ts';
import { askOpenMr } from '../actions.ts';
import { Select } from '../components/Select.tsx';
import { ContextSection } from '../context/ContextSection.tsx';
import { AgentTimeline } from './Timeline.tsx';
import { isLocalMr, MrBadge, mrNum } from '../mrs/mr-ui.tsx';
import { agentNodeOf, issueNodeOf, mrNodeOf, mrOfAgent, useStore } from '../state/store.ts';
import {
  fmtK,
  fmtUsd,
  isBlank,
  isLive,
  reposText,
  roleLabel,
  statusLabel,
  statusShort,
  statusTone,
} from './agent-ui.ts';

const EMPTY: never[] = [];

/** Agente na árvore de equipe (painel da issue, painel do agente), com os filhos embaixo. */
export function AgentTreeItem({ agent: a }: { agent: Agent }) {
  const agents = useStore((s) => s.agents);
  const kids = Object.values(agents).filter((x) => x.parentId === a.id);
  const selected = useStore((s) => s.selected);
  const node = useStore((s) => agentNodeOf(s, a.id));
  const projects = useStore((s) => s.settings?.projects ?? EMPTY);
  return (
    <li>
      <button className={selected === node?.id ? 'cur' : ''} onClick={() => node && focusNode(node.id)}>
        <span className={`sd ${a.status}`} />
        <span className="nm">{a.name}</span>
        <span className={`badge ${statusTone(a.status)}`}>{statusShort(a.status)}</span>
        <span className="mt">
          {roleLabel(a)} · {isBlank(a) ? 'sem instrução' : reposText(a, projects)}
        </span>
      </button>
      {kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <AgentTreeItem key={k.id} agent={k} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Plano (report_plan) e equipe do agente: a árvore a partir da raiz e o que ele ainda pode criar. */
function PlanAndTeam({ agent: a }: { agent: Agent }) {
  const agents = useStore((s) => s.agents);
  let root = a;
  while (root.parentId && agents[root.parentId]) root = agents[root.parentId]!;
  const hasTeam = root.id !== a.id || Object.values(agents).some((x) => x.parentId === a.id);
  const left = a.maxDepth - a.depth;
  // tokens e custo da árvore inteira (o orçamento do supervisor vale para ela)
  const tree = [root];
  for (let i = 0; i < tree.length; i++)
    tree.push(...Object.values(agents).filter((x) => x.parentId === tree[i]!.id));
  const treeTokens = tree.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
  const treeCost = tree.reduce((s, x) => s + x.costUsd, 0);
  return (
    <>
      {a.plan && a.plan.length > 0 && (
        <div className="grp">
          <h4>Plano</h4>
          <div className="plan" style={{ margin: 0 }}>
            {a.plan.map((it, j) => (
              <span key={j} className={`it${it.done ? ' ok' : it.agentId ? ' wip' : ''}`}>
                <span className="ck">{it.done ? '✓' : ''}</span>
                <span className="tx">{it.text}</span>
                {it.agentId && agents[it.agentId] && <span className="who">{agents[it.agentId]!.name}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {(hasTeam || (left > 0 && !isBlank(a))) && (
        <div className="grp">
          <h4>Equipe</h4>
          {hasTeam ? (
            <ul className="tree">
              <AgentTreeItem agent={root} />
            </ul>
          ) : null}
          {hasTeam && (
            <p className="lab" style={{ margin: 0 }}>
              Árvore de {tree.length} agentes: {fmtK(treeTokens)} tokens · {fmtUsd(treeCost)}
            </p>
          )}
          <p className="lab" style={{ margin: 0 }}>
            {left > 0
              ? `${a.name} pode criar sub-agentes até ${left} nível${left > 1 ? 's' : ''} abaixo dele.`
              : `Profundidade ${a.depth} de ${a.maxDepth}: sem novos sub-agentes.`}
          </p>
        </div>
      )}
    </>
  );
}

/** Painel da direita para um agente: estado, controles, números e detalhes (como no protótipo). */
export function AgentPanel({
  agentId,
  nodeId,
  inFocus = false,
}: {
  agentId: string;
  nodeId: string;
  inFocus?: boolean;
}) {
  const a = useStore((s) => s.agents[agentId]);
  const events = useStore((s) => s.agentEvents[agentId] ?? EMPTY);
  const projects = useStore((s) => s.settings?.projects ?? EMPTY);
  const issue = useStore((s) => (a?.issueRef ? s.issues[a.issueRef] : undefined));
  const issueNode = useStore((s) => (a?.issueRef ? issueNodeOf(s, a.issueRef) : undefined));
  const mr = useStore((s) => (a ? mrOfAgent(s, a.id) : undefined));
  const waiting = useStore((s) => Object.values(s.approvals).filter((p) => p.agentId === agentId).length);
  const focusId = useStore((s) => s.focusId);
  const st = useStore.getState();
  if (!a) return <p className="lab">Carregando…</p>;

  const live = isLive(a);
  const blank = isBlank(a);
  const repo = projects.find((p) => p.id === a.repos[0]);
  const lastTool = [...events].reverse().find((e) => e.body.kind === 'tool_use');
  const now =
    lastTool?.body.kind === 'tool_use' ? `${lastTool.body.name}(${lastTool.body.summary})` : 'Preparando';
  const turns = events.filter((e) => e.body.kind === 'result').length;

  const ctl = live ? (
    <button className="btn" onClick={() => st.pauseAgent(a.id)}>
      Pausar
    </button>
  ) : (a.status === 'paused' || a.status === 'error') && a.sessionId ? (
    <button className="btn" onClick={() => st.resumeAgent(a.id)}>
      Retomar
    </button>
  ) : null;
  const stop =
    live || a.status === 'queued' ? (
      <button className="btn danger" onClick={() => st.stopAgent(a.id)}>
        Parar
      </button>
    ) : null;

  return (
    <>
      {!inFocus && (
        <>
          <div className="ag-head">
            <div className="ag-title">
              <h3>{a.name}</h3>
              <span className={`badge ${statusTone(a.status)}`}>
                <span className="d" />
                {statusLabel(a.status)}
              </span>
            </div>
            <p className="ag-sub">
              {roleLabel(a)} · {issue ? `Issue #${issue.iid} · ${issue.title}` : a.title}
            </p>
          </div>
          <div className="ag-actions">
            {focusId === nodeId ? (
              <button className="btn" onClick={() => st.openFocus(null)}>
                Sair do foco
              </button>
            ) : (
              <button className="btn primary" onClick={() => st.openFocus(nodeId)}>
                Abrir em foco
              </button>
            )}
            {ctl}
            {stop}
          </div>
        </>
      )}
      {inFocus && (ctl || stop) && (
        <div className="ag-actions">
          {ctl}
          {stop}
        </div>
      )}

      {waiting > 0 && (
        <div className="callout">
          <span>Este agente está aguardando sua permissão.</span>
          <button
            className="btn sm"
            onClick={() => (focusId === nodeId ? st.setTab('actions') : st.openFocus(nodeId))}
          >
            Revisar
          </button>
        </div>
      )}
      {a.error && a.status !== 'running' && (
        <div className="callout" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}>
          <span>{a.error}</span>
        </div>
      )}

      {blank ? (
        <ol className="steps">
          <li className={repo ? 'ok' : 'cur'}>
            <b>Repositório</b>
            {repo ? (
              <span className="badge repo">{repo.name}</span>
            ) : (
              <>
                <Select
                  label="Repositório do agente"
                  value=""
                  onChange={(v) => v && st.updateAgent(a.id, { repos: [Number(v)] })}
                  options={projects.map((p) => ({
                    value: String(p.id),
                    label: p.local ? `${p.name} (local)` : p.pathWithNamespace,
                  }))}
                />
                <span className="lab">
                  Ou arraste um repositório da aba Repos, ou uma issue, para cima do agente.
                </span>
              </>
            )}
          </li>
          <li className={repo ? 'cur' : ''}>
            <b>Primeira instrução</b>
            <span className="lab">Escreva na janela do agente. Ele começa por ela.</span>
          </li>
        </ol>
      ) : (
        live && (
          <div className="prog">
            <div className="prog-meta">
              <span>Agora</span>
            </div>
            <div className="now">{now}</div>
          </div>
        )
      )}

      {a.sessionId && (
        <div className="stats3">
          <div className="stat">
            <b>{fmtK(a.inputTokens + a.outputTokens)}</b>
            <span>Tokens</span>
          </div>
          <div className="stat">
            <b>{fmtUsd(a.costUsd)}</b>
            <span>Custo</span>
          </div>
          <div className="stat">
            <b>{turns}</b>
            <span>Turnos</span>
          </div>
        </div>
      )}

      <PlanAndTeam agent={a} />

      {(!blank || repo) && <ContextSection agent={a} />}

      <AgentTimeline key={a.id} agentId={a.id} />

      <div className="grp">
        <h4>Detalhes</h4>
        <dl className="kv">
          <dt>Repositório</dt>
          <dd>{repo ? <span className="badge repo">{repo.name}</span> : '—'}</dd>
          {a.branch && (
            <>
              <dt>Branch</dt>
              <dd className="mono">{a.branch}</dd>
            </>
          )}
          {a.worktreePath && (
            <>
              <dt>Worktree</dt>
              <dd className="mono" title={a.worktreePath}>
                {a.worktreePath.replace(/^.*\/worktrees\//, '…/worktrees/')}
              </dd>
            </>
          )}
          {issue && (
            <>
              <dt>Issue</dt>
              <dd>
                {issueNode ? (
                  <button className="btn sm" onClick={() => focusNode(issueNode.id)}>
                    #{issue.iid}
                  </button>
                ) : (
                  `#${issue.iid}`
                )}
              </dd>
            </>
          )}
          {mr && (
            <>
              <dt>{isLocalMr(mr) ? 'Revisão' : 'MR'}</dt>
              <dd style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    const n = mrNodeOf(useStore.getState(), mr.ref);
                    if (n) focusNode(n.id);
                  }}
                >
                  {mrNum(mr)}
                </button>
                <MrBadge mr={mr} />
              </dd>
            </>
          )}
          {a.contextTokens > 0 && (
            <>
              <dt>Contexto</dt>
              <dd>{fmtK(a.contextTokens)} tokens no último turno</dd>
            </>
          )}
          {a.sessionId && (
            <>
              <dt>Sessão</dt>
              <dd className="mono" title={a.sessionId}>
                {a.sessionId.slice(0, 8)}
              </dd>
            </>
          )}
        </dl>
        {!mr && a.worktreePath && (
          <div>
            <button className="btn sm" onClick={() => askOpenMr(a.id)}>
              Abrir MR agora
            </button>
          </div>
        )}
      </div>
      {!inFocus && (
        <div className="foot-danger">
          <button className="btn plain danger sm" onClick={() => st.removeNode(nodeId)}>
            Remover do canvas
          </button>
        </div>
      )}
    </>
  );
}
