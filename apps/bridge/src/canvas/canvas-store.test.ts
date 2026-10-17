import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.ts';
import { agent, mergeRequestCache, node, note, noteLink } from '../db/schema.ts';
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

describe('arquivar issue', () => {
  it('leva issue, agentes, MRs e notas do grupo; a limpeza não apaga; restaurar devolve tudo', () => {
    const { db, close } = openDb(':memory:');
    const store = new CanvasStore(db);
    const ts = new Date().toISOString();
    const put = (id: string, type: 'agent' | 'note' | 'issue' | 'mr', refId: string) =>
      db.insert(node).values({ id, type, refId, x: 0, y: 0, createdAt: ts }).run();
    const mkAgent = (id: string, issueRef: string | null) =>
      db
        .insert(agent)
        .values({
          id,
          name: id,
          role: 'main',
          parentId: null,
          issueRef,
          repos: [101],
          instruction: 'x',
          title: 'x',
          status: 'done',
          depth: 0,
          maxDepth: 0,
          openMr: true,
          createdAt: ts,
        })
        .run();
    store.cacheIssues([
      {
        ref: '101#142',
        projectId: 101,
        projectPath: 'g/p',
        iid: 142,
        title: 'Webhook',
        description: '',
        labels: [],
        author: 'ana',
        state: 'opened',
        updatedAt: ts,
        commentCount: 0,
        webUrl: 'u',
      },
    ]);
    put('n-i', 'issue', '101#142');
    mkAgent('a1', '101#142');
    put('n-a1', 'agent', 'a1');
    mkAgent('a2', null);
    put('n-a2', 'agent', 'a2'); // outro trabalho: fica
    db.insert(mergeRequestCache)
      .values({
        projectId: 101,
        iid: 88,
        projectPath: 'g/p',
        title: 't',
        description: '',
        sourceBranch: 'b',
        targetBranch: 'main',
        state: 'opened',
        pipelineStatus: 'success',
        webUrl: 'u',
        agentId: 'a1',
        issueRef: '101#142',
        updatedAt: ts,
        fetchedAt: ts,
      })
      .run();
    put('n-mr', 'mr', '101!88');
    // nota de passagem do a1, nota ligada só à issue e nota ligada também ao a2
    for (const [id, by] of [
      ['t1', 'a1'],
      ['t2', 'user'],
      ['t3', 'user'],
    ] as const)
      db.insert(note)
        .values({ id, title: id, body: '', isHandoff: false, createdBy: by, createdAt: ts, updatedAt: ts })
        .run();
    put('n-t1', 'note', 't1');
    put('n-t2', 'note', 't2');
    put('n-t3', 'note', 't3');
    db.insert(noteLink).values({ noteId: 't2', targetNodeId: 'n-i' }).run();
    db.insert(noteLink).values({ noteId: 't3', targetNodeId: 'n-i' }).run();
    db.insert(noteLink).values({ noteId: 't3', targetNodeId: 'n-a2' }).run();

    const out = store.archiveIssue('n-i');
    const removed = out.flatMap((m) => (m.type === 'node.remove' ? [m.nodeId] : [])).sort();
    expect(removed).toEqual(['n-a1', 'n-i', 'n-mr', 'n-t1', 'n-t2']);
    expect(
      store
        .liveNodes()
        .map((n) => n.id)
        .sort(),
    ).toEqual(['n-a2', 'n-t3']);
    expect(store.archivedIssues()).toEqual([expect.objectContaining({ issueRef: '101#142', items: 4 })]);

    // a limpeza de removidos (mesmo velhos) não apaga arquivados
    expect(store.purgeRemoved(-1)).toBe(0);

    // trazer a issue de novo (arrastar do backlog) restaura o grupo
    store.apply({ type: 'issue.place', nodeId: 'n-novo', issueRef: '101#142', x: 0, y: 0 });
    expect(
      store
        .liveNodes()
        .map((n) => n.id)
        .sort(),
    ).toEqual(['n-a1', 'n-a2', 'n-i', 'n-mr', 'n-t1', 'n-t2', 'n-t3']);
    expect(store.archivedIssues()).toEqual([]);
    close();
  });
});
