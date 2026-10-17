import { NodeResizeControl, ResizeControlVariant } from '@xyflow/react';
import { NODE_SIZE_LIMITS, type NodeType } from '@agent-canvas/shared';

/**
 * Alças de redimensionar do cartão: borda direita, borda de baixo e o canto. Só cresce para a
 * direita e para baixo, então a posição do cartão não muda. Os limites vêm de NODE_SIZE_LIMITS;
 * a altura mínima é a do conteúdo (o CSS não deixa o cartão encolher abaixo dele).
 */
export function NodeResize({ type }: { type: NodeType }) {
  const l = NODE_SIZE_LIMITS[type];
  const bounds = { minWidth: l.minW, maxWidth: l.maxW, minHeight: 40, maxHeight: l.maxH };
  return (
    <>
      <NodeResizeControl
        {...bounds}
        variant={ResizeControlVariant.Line}
        position="right"
        className="nresize"
        resizeDirection="horizontal"
      />
      <NodeResizeControl
        {...bounds}
        variant={ResizeControlVariant.Line}
        position="bottom"
        className="nresize"
        resizeDirection="vertical"
      />
      <NodeResizeControl {...bounds} position="bottom-right" className="nresize corner" autoScale={false}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </NodeResizeControl>
    </>
  );
}
