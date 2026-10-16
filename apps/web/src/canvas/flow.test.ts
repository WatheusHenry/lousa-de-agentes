import { describe, expect, it } from 'vitest';
import { edgePath, toFlowNode } from './flow.ts';

describe('edgePath', () => {
  it('desce na vertical quando o destino está abaixo', () => {
    expect(edgePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 200, w: 100, h: 50 })).toBe(
      'M50,50 C50,123.5 50,123.5 50,197',
    );
  });
  it('sai pela lateral quando o destino está ao lado ou acima', () => {
    expect(edgePath({ x: 0, y: 100, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 })).toBe(
      'M100,125 C198.5,125 198.5,25 297,25',
    );
  });
});

describe('toFlowNode', () => {
  const n = { id: 'n1', type: 'note' as const, refId: 't1', x: 1, y: 2, createdAt: '' };
  it('nota arrasta pelo cabeçalho', () => {
    expect(toFlowNode(n, true)).toMatchObject({
      dragHandle: '.nhead',
      selected: true,
      position: { x: 1, y: 2 },
    });
  });
  it('não pula de volta enquanto o nó está sendo arrastado', () => {
    const prev = { ...toFlowNode(n, false), dragging: true, position: { x: 50, y: 60 } };
    expect(toFlowNode(n, false, prev).position).toEqual({ x: 50, y: 60 });
  });
});
