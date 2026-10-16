import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { startIssueAgent } from '../actions.ts';
import { IconExpand, IconIssue } from '../icons.tsx';
import { isRedLabel, repoName } from '../lib/format.ts';
import { useStore } from '../state/store.ts';
import type { FlowNode } from '../canvas/flow.ts';

function IssueNodeView({ id, data }: NodeProps<FlowNode>) {
  const issue = useStore((s) => s.issues[data.refId]);
  const fresh = useStore((s) => !!s.fresh[id]);
  const noteCount = useStore((s) => s.noteLinks.filter((l) => l.targetNodeId === id).length);
  const openFocus = useStore((s) => s.openFocus);
  const agentCount = useStore(
    (s) =>
      Object.values(s.nodes).filter((n) => n.type === 'agent' && s.agents[n.refId]?.issueRef === data.refId)
        .length,
  );

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
      </div>
      <div className="nfoot">
        <span className="nmeta">
          {agentCount ? `${agentCount} agente${agentCount > 1 ? 's' : ''}` : 'Sem agentes'} ·{' '}
          {issue.commentCount} coment.
          {noteCount ? ` · ${noteCount} nota${noteCount > 1 ? 's' : ''}` : ''}
        </span>
        <button className="btn sm nodrag" onClick={() => startIssueAgent(id)}>
          Iniciar
        </button>
      </div>
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
    </div>
  );
}

export const IssueNode = memo(IssueNodeView);
