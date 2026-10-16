import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, Issue, MergeRequest, StateSnapshot } from '@agent-canvas/shared';
import { hasPendingUndo, liveMrs, mrOfAgent, useStore } from './store.ts';
import { actionsCount } from '../panels/Sidebar.tsx';

const issue: Issue = {
  ref: '101#142',
  projectId: 101,
  projectPath: 'grupo/payments-api',
  iid: 142,
  title: 'Webhook duplica cobrança',
  description: '',
  labels: ['bug'],
  author: 'ana',
  state: 'opened',
  updatedAt: '2026-10-01T00:00:00Z',
  commentCount: 2,
  webUrl: 'x',
};

const empty: StateSnapshot = {
  settings: {
    mode: 'demo',
    baseUrl: 'https://gitlab.com',
    reposDir: '',
    hasToken: false,
    tokenSource: null,
    user: null,
    projects: [],
    configured: true,
  },
  nodes: [],
  edges: [],
  notes: [],
  noteLinks: [],
  mergeRequests: [],
  issues: [issue],
  activity: [],
  agents: [],
  agentEvents: [],
  approvals: [],
  policies: [],
};

let sent: ClientMessage[];

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  useStore.getState().setSender({ send: (m) => sent.push(m) });
  useStore.getState().loadSnapshot(empty);
  useStore.setState({ nodes: {}, edges: {}, notes: {}, noteLinks: [], toast: null, selected: null });
});
afterEach(() => vi.useRealTimers());

describe('store do canvas', () => {
  it('coloca uma issue uma vez só', () => {
    const st = useStore.getState();
    const id = st.placeIssue('101#142', { x: 10, y: 20 });
    expect(useStore.getState().placeIssue('101#142', { x: 0, y: 0 })).toBe(id);
    expect(sent).toEqual([{ type: 'issue.place', nodeId: id, issueRef: '101#142', x: 10, y: 20 }]);
  });

  it('nota: cria, vincula, edita com debounce e não perde edição local para o eco do servidor', () => {
    const st = useStore.getState();
    const issueId = st.placeIssue('101#142', { x: 0, y: 0 });
    const { noteId, nodeId } = st.createNote({ x: 300, y: 0 }, issueId);
    expect(sent.map((m) => m.type)).toEqual(['issue.place', 'note.create', 'note.link']);
    const edges = Object.values(useStore.getState().edges);
    expect(edges).toEqual([expect.objectContaining({ fromNodeId: nodeId, toNodeId: issueId, kind: 'note' })]);

    st.updateNote(noteId, { body: 'a' });
    st.updateNote(noteId, { body: 'ab', title: 'T' });
    // eco atrasado do servidor com o texto antigo: ignorado enquanto há edição pendente
    useStore.getState().applyServer({
      type: 'note.upsert',
      note: { id: noteId, title: 'Nova nota', body: '', isHandoff: false, createdBy: 'user' },
    });
    expect(useStore.getState().notes[noteId]!.body).toBe('ab');
    vi.advanceTimersByTime(500);
    expect(sent.at(-1)).toEqual({ type: 'note.update', noteId, body: 'ab', title: 'T' });

    st.unlinkNote(noteId, issueId);
    expect(Object.values(useStore.getState().edges)).toHaveLength(0);
    expect(sent.at(-1)).toEqual({ type: 'note.unlink', noteId, targetNodeId: issueId });
  });

  it('remover mostra aviso e o desfazer pede a restauração', () => {
    const st = useStore.getState();
    const id = st.placeIssue('101#142', { x: 0, y: 0 });
    st.select(id);
    st.removeNode(id);
    const s = useStore.getState();
    expect(s.nodes[id]).toBeUndefined();
    expect(s.selected).toBeNull();
    expect(s.toast?.msg).toBe('Issue #142 removida do canvas');
    expect(hasPendingUndo()).toBe(true);
    s.undo();
    expect(sent.at(-1)).toEqual({ type: 'node.restore', nodeId: id });
    expect(hasPendingUndo()).toBe(false);
    expect(useStore.getState().toast).toBeNull();
  });

  it('mover só envia quando a posição muda', () => {
    const st = useStore.getState();
    const id = st.placeIssue('101#142', { x: 0, y: 0 });
    st.moveNode(id, 0, 0);
    st.moveNode(id, 5, 6);
    expect(sent.filter((m) => m.type === 'node.move')).toEqual([
      { type: 'node.move', nodeId: id, x: 5, y: 6 },
    ]);
  });

  it('erro do servidor vira aviso', () => {
    useStore.getState().applyServer({ type: 'error', message: 'Issue desconhecida.' });
    expect(useStore.getState().toast?.msg).toBe('Issue desconhecida.');
  });

  it('MR: chega pelo servidor, conta nas Ações quando fica pronto e o merge é um pedido ao bridge', () => {
    const mr: MergeRequest = {
      ref: '101!88',
      projectId: 101,
      projectPath: 'acme/payments-api',
      iid: 88,
      title: 'Corrige webhook',
      description: '',
      sourceBranch: 'agent/142-webhook',
      targetBranch: 'main',
      state: 'opened',
      pipelineStatus: 'running',
      webUrl: 'x',
      additions: 3,
      deletions: 1,
      agentId: 'a1',
      issueRef: '101#142',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    const st = useStore.getState();
    st.applyServer({ type: 'mr.upsert', mr });
    st.applyServer({
      type: 'node.upsert',
      node: { id: 'n-mr', type: 'mr', refId: mr.ref, x: 0, y: 0, createdAt: mr.updatedAt },
    });
    expect(liveMrs(useStore.getState())).toHaveLength(1);
    expect(mrOfAgent(useStore.getState(), 'a1')?.iid).toBe(88);
    const before = actionsCount(useStore.getState());
    st.applyServer({ type: 'mr.upsert', mr: { ...mr, pipelineStatus: 'success' } });
    expect(actionsCount(useStore.getState())).toBe(before + 1);

    st.mergeMr(mr.ref);
    st.commentMr(mr.ref, 'ok');
    expect(sent.slice(-2)).toEqual([
      { type: 'mr.merge', mrRef: '101!88' },
      { type: 'mr.comment', mrRef: '101!88', body: 'ok' },
    ]);
    st.applyServer({ type: 'thread.changed', target: 'mr', ref: mr.ref });
    expect(useStore.getState().threadVersion[mr.ref]).toBe(1);
  });
});
