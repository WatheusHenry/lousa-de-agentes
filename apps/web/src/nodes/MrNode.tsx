import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { IconExpand, IconMr } from '../icons.tsx';
import { DiffStat, MrBadge, mrName } from '../mrs/mr-ui.tsx';
import { useStore } from '../state/store.ts';
import { NodeResize } from '../canvas/NodeResize.tsx';
import type { FlowNode } from '../canvas/flow.ts';

function MrNodeView({ id, data }: NodeProps<FlowNode>) {
  const mr = useStore((s) => s.mergeRequests[data.refId]);
  const fresh = useStore((s) => !!s.fresh[id]);
  const openFocus = useStore((s) => s.openFocus);
  const handles = (
    <>
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
    </>
  );
  if (!mr)
    return (
      <div className="card ncard" data-drag>
        <div className="nhead">
          <span className="ico mr">
            <IconMr />
          </span>
          <span className="num">
            {data.refId.startsWith('-') ? 'Revisão #' : 'MR !'}
            {data.refId.split('!')[1]}
          </span>
        </div>
        <div className="nmeta">Carregando…</div>
        {handles}
      </div>
    );
  return (
    <div className={`card ncard${fresh ? ' enter' : ''}`} data-drag>
      <div className="nhead">
        <span className="ico mr">
          <IconMr />
        </span>
        <span className="num">{mrName(mr)}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="badge repo">{mr.projectPath.split('/').pop()}</span>
        <button
          className="btn plain icon xs expand nodrag"
          aria-label="Expandir"
          title="Expandir"
          onClick={() => openFocus(id)}
        >
          <IconExpand />
        </button>
      </div>
      <div className="ntitle">{mr.title}</div>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
        {mr.sourceBranch} → {mr.targetBranch}
      </div>
      <div className="nfoot">
        <MrBadge mr={mr} />
        <DiffStat add={mr.additions} del={mr.deletions} />
      </div>
      {handles}
      <NodeResize type="mr" />
    </div>
  );
}

export const MrNode = memo(MrNodeView);
