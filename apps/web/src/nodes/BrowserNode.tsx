import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { BrowserBar, BrowserScreen, shortUrl } from '../browser/BrowserView.tsx';
import { IconExpand, IconGlobe } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import type { FlowNode } from '../canvas/flow.ts';

/** Navegador no canvas: a mesma tela que o agente usa, ao vivo, e que você também pode usar. */
function BrowserNodeView({ id, data }: NodeProps<FlowNode>) {
  const b = useStore((s) => s.browsers[data.refId]);
  const owner = useStore((s) => (b?.ownerAgentId ? s.agents[b.ownerAgentId]?.name : undefined));
  const fresh = useStore((s) => !!s.fresh[id]);
  const openFocus = useStore((s) => s.openFocus);
  if (!b) return null;
  return (
    <div className={`card bwin${fresh ? ' enter' : ''}`}>
      <div className="bbar" data-drag>
        <span className="ico browser">
          <IconGlobe />
        </span>
        <span className="btitle" title={b.url}>
          {b.title || shortUrl(b.url) || 'Navegador'}
        </span>
        {owner && <span className="bowner">usado por {owner}</span>}
        <button
          className="btn plain icon xs expand nodrag"
          aria-label="Abrir navegador em tela grande"
          title="Abrir em foco"
          onClick={() => openFocus(id)}
        >
          <IconExpand />
        </button>
      </div>
      <BrowserBar browser={b} />
      <BrowserScreen browser={b} />
      <Handle type="target" position={Position.Left} className="hidden-handle" />
      <Handle type="source" position={Position.Right} className="hidden-handle" />
    </div>
  );
}

export const BrowserNode = memo(BrowserNodeView);
