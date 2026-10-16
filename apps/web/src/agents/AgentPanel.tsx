import type { Agent } from '@agent-canvas/shared';
import { focusNode } from '../canvas/viewport.ts';
import { agentNodeOf, issueNodeOf, useStore } from '../state/store.ts';
import {
  fmtK,
  fmtUsd,
  isBlank,
  isLive,
  roleLabel,
  statusLabel,
  statusShort,
  statusTone,
} from './agent-ui.ts';

const EMPTY: never[] = [];

/** Agente na árvore de equipe (painel da issue, painel do agente). */
export function AgentTreeItem({ agent: a }: { agent: Agent }) {
  const selected = useStore((s) => s.selected);
  const node = useStore((s) => agentNodeOf(s, a.id));
  const repo = useStore((s) => s.settings?.projects.find((p) => p.id === a.repos[0]));
  return (
    <li>
      <button className={selected === node?.id ? 'cur' : ''} onClick={() => node && focusNode(node.id)}>
        <span className={`sd ${a.status}`} />
        <span className="nm">{a.name}</span>
        <span className={`badge ${statusTone(a.status)}`}>{statusShort(a.status)}</span>
        <span className="mt">
          {roleLabel(a)} · {isBlank(a) ? 'sem instrução' : (repo?.name ?? 'sem repositório')}
        </span>
      </button>
    </li>
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
  const stop = live ? (
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
        <div className="callout info">
          <span>
            {repo
              ? 'Contexto pronto. Envie a primeira instrução pela janela do agente.'
              : 'Escolha um repositório (ou arraste uma issue para cima do agente) e envie a primeira instrução.'}
          </span>
        </div>
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

      <div className="grp">
        <h4>Detalhes</h4>
        <dl className="kv">
          <dt>Repositório</dt>
          <dd>
            {a.worktreePath || !blank ? (
              repo ? (
                <span className="badge repo">{repo.name}</span>
              ) : (
                '—'
              )
            ) : (
              <select
                className="field"
                value={a.repos[0] ?? ''}
                aria-label="Repositório do agente"
                onChange={(e) => e.target.value && st.updateAgent(a.id, { repos: [Number(e.target.value)] })}
              >
                <option value="">Escolher…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.pathWithNamespace}
                  </option>
                ))}
              </select>
            )}
          </dd>
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
