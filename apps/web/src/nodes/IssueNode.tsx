import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { detectRepos, type AgentStatus } from '@agent-canvas/shared';
import { startFromCard } from '../actions.ts';
import { IconExpand, IconIssue } from '../icons.tsx';
import { checklist, isRedLabel, repoName } from '../lib/format.ts';
import { useStore } from '../state/store.ts';
import { NodeResize } from '../canvas/NodeResize.tsx';
import type { FlowNode } from '../canvas/flow.ts';

function IssueNodeView({ id, data }: NodeProps<FlowNode>) {
  const issue = useStore((s) => s.issues[data.refId]);
  const fresh = useStore((s) => !!s.fresh[id]);
  const noteCount = useStore((s) => s.noteLinks.filter((l) => l.targetNodeId === id).length);
  const openFocus = useStore((s) => s.openFocus);
  // a issue cita outros repositórios: o botão abre o painel para conferir antes de iniciar
  const multi = useStore((s) => {
    const i = s.issues[data.refId];
    return !!i && detectRepos(i, s.settings?.projects ?? []).length > 1;
  });
  // status dos agentes da issue no canvas, em texto (seletor estável para o zustand)
  const statusKey = useStore((s) =>
    Object.values(s.nodes)
      .filter((n) => n.type === 'agent' && s.agents[n.refId]?.issueRef === data.refId)
      .map((n) => s.agents[n.refId]!.status)
      .join(','),
  );
  const mrCount = useStore(
    (s) =>
      Object.values(s.mergeRequests).filter((m) => m.issueRef === data.refId && m.state !== 'closed').length,
  );
  const statuses = statusKey ? (statusKey.split(',') as AgentStatus[]) : [];

  if (!issue)
    return (
      <div className="card ncard" data-drag>
        <div className="nhead">
          <span className="ico issue">
            <IconIssue />
          </span>
          <span className="num">Issue {data.refId.split('#')[1]}</span>
        </div>
        <div className="nmeta">Carregando dados do GitLab…</div>
        <Handle type="target" position={Position.Top} className="hidden-handle" />
        <Handle type="source" position={Position.Bottom} className="hidden-handle" />
      </div>
    );

  const crit = checklist(issue.description);
  return (
    <div className={`card ncard${fresh ? ' enter' : ''}`} data-drag>
      <div className="nhead">
        <span className="ico issue">
          <IconIssue />
        </span>
        <span className="num">Issue #{issue.iid}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {issue.labels.slice(0, 3).map((l) => (
          <span key={l} className={`badge ${isRedLabel(l) ? 'issue' : ''}`}>
            {l}
          </span>
        ))}
        <button
          className="btn plain icon xs expand nodrag"
          aria-label="Expandir"
          title="Expandir"
          onClick={() => openFocus(id)}
        >
          <IconExpand />
        </button>
      </div>
      <div className="ntitle">{issue.title}</div>
      <div className="tags">
        <span className="badge repo">{repoName(issue)}</span>
        {crit.length > 0 && (
          <span className="badge crit" title="Critérios de aceite marcados na issue">
            {crit.filter((c) => c.done).length}/{crit.length} critérios
          </span>
        )}
      </div>
      {statuses.length > 0 && (
        <div className="ag-prog" title="Agentes desta issue no canvas">
          <span className="dots">
            {statuses.slice(0, 8).map((st, k) => (
              <span key={k} className={`sd ${st}`} />
            ))}
          </span>
          <span>{progressText(statuses, mrCount)}</span>
        </div>
      )}
      <div className="nfoot">
        <span className="nmeta">
          {statuses.length ? `${statuses.length} agente${statuses.length > 1 ? 's' : ''}` : 'Sem agentes'} ·{' '}
          {issue.commentCount} coment.
          {noteCount ? ` · ${noteCount} nota${noteCount > 1 ? 's' : ''}` : ''}
        </span>
        <button
          className="btn sm nodrag"
          onClick={() => startFromCard(id)}
          title={
            multi
              ? 'A issue cita outros repositórios: confira no painel antes de iniciar o orquestrador'
              : 'Inicia um agente no projeto da issue, que abre o MR ao terminar'
          }
        >
          {multi ? 'Iniciar…' : 'Iniciar'}
        </button>
      </div>
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
      <NodeResize type="issue" />
    </div>
  );
}

/** "2 trabalhando · 1 aguardando você · 1 MR": o que importa primeiro. */
function progressText(statuses: AgentStatus[], mrs: number): string {
  const n = (f: (s: AgentStatus) => boolean) => statuses.filter(f).length;
  const parts = [
    [n((s) => s === 'waiting'), 'aguardando você', 'aguardando você'],
    [n((s) => s === 'error'), 'com erro', 'com erro'],
    [n((s) => s === 'running' || s === 'coordinating'), 'trabalhando', 'trabalhando'],
    [n((s) => s === 'queued'), 'na fila', 'na fila'],
    [n((s) => s === 'done'), 'concluído', 'concluídos'],
  ] as const;
  const out = parts.filter(([c]) => c > 0).map(([c, one, many]) => `${c} ${c > 1 ? many : one}`);
  if (mrs) out.push(`${mrs} MR${mrs > 1 ? 's' : ''}`);
  return out.join(' · ') || 'parados';
}

export const IssueNode = memo(IssueNodeView);
