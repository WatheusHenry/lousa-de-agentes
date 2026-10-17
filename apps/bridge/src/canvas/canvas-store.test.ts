import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.ts';
import { node } from '../db/schema.ts';
import { CanvasStore } from './canvas-store.ts';

describe('lugar livre para nós criados pelo bridge', () => {
  it('não sobrepõe cartões: desce, e passa para a coluna ao lado quando a de baixo está cheia', () => {
    const { db, close } = openDb(':memory:');
    const store = new CanvasStore(db);
    const put = (id: string, type: 'agent' | 'note' | 'issue' | 'mr', x: number, y: number) =>
      db.insert(node).values({ id, type, refId: id, x, y, createdAt: new Date().toISOString() }).run();

    // vazio: fica onde pediu
    expect(store.freeSpot('note', { x: 500, y: 300 })).toEqual({ x: 500, y: 300 });

    // um agente ocupando o lugar: a nota desce até sair de baixo dele
    put('a1', 'agent', 480, 260);
    const spot = store.freeSpot('note', { x: 500, y: 300 });
    expect(spot.x).toBe(500);
    expect(spot.y).toBeGreaterThanOrEqual(260 + 380 + 30);

    // nós removidos não ocupam espaço
    db.update(node).set({ removedAt: new Date().toISOString() }).run();
    expect(store.freeSpot('note', { x: 500, y: 300 })).toEqual({ x: 500, y: 300 });

    // coluna inteira ocupada: vai para a direita
    for (let i = 0; i < 6; i++) put(`c${i}`, 'agent', 0, i * 400);
    const side = store.freeSpot('agent', { x: 0, y: 0 });
    expect(side.x).toBeGreaterThan(0);
    close();
  });
});
