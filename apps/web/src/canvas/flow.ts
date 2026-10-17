import type { Edge, Node } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { CanvasEdge, CanvasNode, EdgeKind } from '@agent-canvas/shared';

export type FlowNode = Node<{ refId: string }, CanvasNode['type']>;
export type FlowEdge = Edge<{ kind: EdgeKind }, 'floating'>;

/**
 * Tamanho do cartão como variáveis CSS (--nw largura, --nh altura mínima). O nó do React Flow
 * fica sem width/height fixos: a altura acompanha o conteúdo e nunca fica menor que ele.
 */
export function sizeStyle(w?: number, h?: number): CSSProperties | undefined {
  if (w === undefined || h === undefined) return undefined;
  return { '--nw': `${w}px`, '--nh': `${h}px` } as CSSProperties;
}

/** Nó do React Flow a partir do nó do bridge. A nota só arrasta pelo cabeçalho (o resto é editável). */
export function toFlowNode(n: CanvasNode, selected: boolean, prev?: FlowNode): FlowNode {
  return {
    ...prev,
    id: n.id,
    type: n.type,
    position: prev?.dragging ? prev.position : { x: n.x, y: n.y },
    data: prev?.data.refId === n.refId ? prev.data : { refId: n.refId },
    selected,
    // durante o redimensionar vale o tamanho local; o do bridge chega no fim
    style: prev?.resizing ? prev.style : sizeStyle(n.w, n.h),
    className: n.w !== undefined ? 'node sized' : 'node',
    ...(n.type === 'note' ? { dragHandle: '.nhead' } : n.type === 'agent' ? { dragHandle: '.wbar' } : {}),
  };
}

export function toFlowEdge(e: CanvasEdge): FlowEdge {
  return { id: e.id, source: e.fromNodeId, target: e.toNodeId, type: 'floating', data: { kind: e.kind } };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Caminho da aresta entre dois cartões, igual ao protótipo: vertical quando o destino está
 * abaixo da origem, horizontal (pela lateral) nos outros casos.
 */
export function edgePath(A: Rect, B: Rect): string {
  if (B.y >= A.y + A.h - 10) {
    const x1 = A.x + A.w / 2,
      y1 = A.y + A.h,
      x2 = B.x + B.w / 2,
      y2 = B.y - 3,
      m = (y2 - y1) / 2;
    return `M${x1},${y1} C${x1},${y1 + m} ${x2},${y2 - m} ${x2},${y2}`;
  }
  const lr = B.x > A.x;
  const x1 = lr ? A.x + A.w : A.x,
    y1 = A.y + Math.min(A.h / 2, 60),
    x2 = lr ? B.x - 3 : B.x + B.w + 3,
    y2 = B.y + Math.min(B.h / 2, 60),
    m = (x2 - x1) / 2;
  return `M${x1},${y1} C${x1 + m},${y1} ${x2 - m},${y2} ${x2},${y2}`;
}
