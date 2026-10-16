import { useInternalNode, type EdgeProps } from '@xyflow/react';
import { isLive } from '../agents/agent-ui.ts';
import { useStore } from '../state/store.ts';
import { edgePath, type FlowEdge } from './flow.ts';

/** Aresta calculada pelos retângulos dos nós, com as classes e setas do protótipo. */
export function FloatingEdge({ id, source, target, data }: EdgeProps<FlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  // aresta animada em azul enquanto o agente de destino trabalha
  const live = useStore((st) => {
    const n = st.nodes[target];
    return n?.type === 'agent' && isLive(st.agents[n.refId]);
  });
  if (!s || !t || !s.measured.width || !t.measured.width) return null;
  const rect = (n: typeof s) => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? 0,
    h: n.measured.height ?? 0,
  });
  const kind = data?.kind ?? 'issue';
  const cls =
    kind === 'note'
      ? 'edge note'
      : `edge${kind === 'spawn' ? ' spawn' : ''}${kind === 'mr' ? ' mrk' : ''}${live ? ' live' : ''}`;
  const marker = kind === 'note' ? 'arrN' : live ? 'arrA' : kind === 'mr' ? 'arrM' : 'arr';
  return (
    <path
      id={id}
      className={`react-flow__edge-path ${cls}`}
      d={edgePath(rect(s), rect(t))}
      markerEnd={`url(#${marker})`}
    />
  );
}

/** Pontas de seta usadas pelas arestas (mesmas do protótipo). */
export function EdgeMarkers() {
  const m = (id: string, color: string) => (
    <marker
      key={id}
      id={id}
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path
        d="M1,1 L9,5 L1,9"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </marker>
  );
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
      <defs>
        {m('arr', '#c3c3c9')}
        {m('arrA', '#0a6cf0')}
        {m('arrM', '#c9b6f3')}
        {m('arrN', '#e9c46a')}
      </defs>
    </svg>
  );
}
