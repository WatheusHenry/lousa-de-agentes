import { create } from 'zustand';
import type {
  Agent,
  AgentContext,
  ContextKind,
  AgentEvent,
  Approval,
  Policy,
  Activity,
  CanvasEdge,
  CanvasNode,
  ClientMessage,
  Issue,
  MergeRequest,
  Note,
  NoteLink,
  ServerMessage,
  SettingsView,
  StateSnapshot,
} from '@agent-canvas/shared';

export type Tab = 'issues' | 'actions' | 'repos' | 'feed';
export type Filter = 'all' | 'bug' | 'agents';
export type Panel = 'help' | 'auto' | null;
export type Connection = 'connecting' | 'open' | 'closed';

export interface Toast {
  id: number;
  msg: string;
  /** Ação do botão; sem ela, o botão é "Desfazer" com o desfazer pendente. */
  action?: { label: string; run: () => void };
}

interface Sender {
  send(m: ClientMessage): void;
}

export interface CanvasState {
  // ---------- espelho do bridge ----------
  settings: SettingsView | null;
  nodes: Record<string, CanvasNode>;
  edges: Record<string, CanvasEdge>;
  notes: Record<string, Note>;
  noteLinks: NoteLink[];
  issues: Record<string, Issue>;
  activity: Activity[];
  connection: Connection;
  agents: Record<string, Agent>;
  /** Eventos por agente, em ordem. */
  agentEvents: Record<string, AgentEvent[]>;
  /** Pedidos de permissão pendentes. */
  approvals: Record<string, Approval>;
  policies: Policy[];
  /** MRs do canvas, por ref (`<projectId>!<iid>`). */
  mergeRequests: Record<string, MergeRequest>;
  /** Contexto de cada agente (itens, tokens, sugestões), conforme o bridge manda. */
  contexts: Record<string, AgentContext>;
  /** Muda quando a discussão de um MR ou issue muda no GitLab (para recarregar). */
  threadVersion: Record<string, number>;

  // ---------- issues abertas (barra lateral) ----------
  openIssueRefs: string[];
  issuesLoading: boolean;
  issuesError: string | null;

  // ---------- interface ----------
  selected: string | null;
  panel: Panel;
  tab: Tab;
  filter: Filter;
  query: string;
  /** Projeto escolhido na aba Issues (null = todos). */
  issueProject: number | null;
  sideHidden: boolean;
  sideOpen: boolean;
  focusId: string | null;
  settingsOpen: boolean;
  toast: Toast | null;
  /** Nós criados agora, que entram com animação. */
  fresh: Record<string, true>;

  // ---------- ações ----------
  setSender(s: Sender | null): void;
  loadSnapshot(s: StateSnapshot): void;
  applyServer(m: ServerMessage): void;
  setIssues(issues: Issue[], errors: string | null): void;
  setIssuesLoading(v: boolean): void;
  setConnection(c: Connection): void;
  setSettings(s: SettingsView): void;

  placeIssue(ref: string, at: { x: number; y: number }): string;
  moveNode(id: string, x: number, y: number): void;
  createNote(at: { x: number; y: number }, linkTo?: string): { noteId: string; nodeId: string };
  updateNote(noteId: string, patch: { title?: string; body?: string }): void;
  flushNote(noteId: string): void;
  linkNote(noteId: string, targetNodeId: string): void;
  unlinkNote(noteId: string, targetNodeId: string): void;
  removeNode(id: string): void;
  undo(): void;

  createAgent(o: {
    at: { x: number; y: number };
    issueRef?: string;
    repos?: number[];
    instruction?: string;
    fromNodeId?: string;
  }): { agentId: string; nodeId: string };
  updateAgent(agentId: string, patch: { repos?: number[]; issueRef?: string | null }): void;
  messageAgent(agentId: string, text: string): void;
  pauseAgent(agentId: string): void;
  resumeAgent(agentId: string): void;
  stopAgent(agentId: string): void;
  decideApproval(approvalId: string, decision: 'allow' | 'deny', remember?: boolean): void;
  removePolicy(policyId: string): void;
  contextAdd(agentId: string, kind: ContextKind, ref: string): void;
  contextRemove(agentId: string, itemId: string): void;
  contextSummarize(agentId: string, itemId: string): void;
  contextUnsummarize(agentId: string, itemId: string): void;
  mergeMr(ref: string): void;
  refreshMr(ref: string): void;
  commentMr(ref: string, body: string): void;
  commentIssue(ref: string, body: string): void;

  select(id: string | null): void;
  setPanel(p: Panel): void;
  setTab(t: Tab): void;
  setFilter(f: Filter): void;
  setQuery(q: string): void;
  setIssueProject(id: number | null): void;
  setSideHidden(v: boolean): void;
  setSideOpen(v: boolean): void;
  openFocus(id: string | null): void;
  setSettingsOpen(v: boolean): void;
  showToast(msg: string, action?: Toast['action']): void;
  hideToast(): void;
}

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const nowIso = () => new Date().toISOString();
const omit = <T>(rec: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));

const MAX_EVENTS = 500;

function groupEvents(list: AgentEvent[]): Record<string, AgentEvent[]> {
  const out: Record<string, AgentEvent[]> = {};
  for (const e of list) (out[e.agentId] ??= []).push(e);
  return out;
}

let sender: Sender | null = null;
let pendingUndo: (() => void) | null = null;
let toastSeq = 0;
const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const notePatches = new Map<string, { title?: string; body?: string }>();

function send(m: ClientMessage) {
  sender?.send(m);
}

const readIssueProject = (): number | null => {
  try {
    const v = Number(localStorage.getItem('ac-issue-project'));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

const readSideHidden = () => {
  try {
    return localStorage.getItem('ac-side-hidden') === '1';
  } catch {
    return false;
  }
};

export const useStore = create<CanvasState>()((set, get) => ({
  settings: null,
  nodes: {},
  edges: {},
  notes: {},
  noteLinks: [],
  issues: {},
  activity: [],
  connection: 'connecting',
  agents: {},
  agentEvents: {},
  approvals: {},
  policies: [],
  mergeRequests: {},
  contexts: {},
  threadVersion: {},
  openIssueRefs: [],
  issuesLoading: false,
  issuesError: null,
  selected: null,
  panel: 'help',
  tab: 'issues',
  filter: 'all',
  query: '',
  issueProject: readIssueProject(),
  sideHidden: readSideHidden(),
  sideOpen: false,
  focusId: null,
  settingsOpen: false,
  toast: null,
  fresh: {},

  setSender(s) {
    sender = s;
  },

  loadSnapshot(s) {
    set((st) => {
      const nodes = byId(s.nodes);
      return {
        settings: s.settings,
        nodes,
        edges: byId(s.edges),
        notes: byId(s.notes),
        noteLinks: s.noteLinks,
        issues: { ...st.issues, ...Object.fromEntries(s.issues.map((i) => [i.ref, i])) },
        activity: s.activity,
        agents: byId(s.agents),
        agentEvents: groupEvents(s.agentEvents),
        approvals: byId(s.approvals.filter((a) => a.status === 'pending')),
        policies: s.policies,
        mergeRequests: Object.fromEntries(s.mergeRequests.map((m) => [m.ref, m])),
        selected: st.selected && nodes[st.selected] ? st.selected : null,
        focusId: st.focusId && nodes[st.focusId] ? st.focusId : null,
      };
    });
  },

  applyServer(m) {
    switch (m.type) {
      case 'hello':
        return;
      case 'state.snapshot':
        return get().loadSnapshot(m.state);
      case 'node.upsert':
        return set((s) => ({ nodes: { ...s.nodes, [m.node.id]: m.node } }));
      case 'node.remove':
        return set((s) => {
          const nodes = omit(s.nodes, m.nodeId);
          return {
            nodes,
            selected: s.selected === m.nodeId ? null : s.selected,
            focusId: s.focusId === m.nodeId ? null : s.focusId,
          };
        });
      case 'edge.upsert':
        return set((s) => ({ edges: { ...s.edges, [m.edge.id]: m.edge } }));
      case 'edge.remove':
        return set((s) => {
          return { edges: omit(s.edges, m.edgeId) };
        });
      case 'note.upsert':
        // não sobrescreve uma edição local ainda não enviada
        if (notePatches.has(m.note.id)) return;
        return set((s) => ({ notes: { ...s.notes, [m.note.id]: m.note } }));
      case 'noteLink.upsert':
        return set((s) =>
          s.noteLinks.some((l) => l.noteId === m.link.noteId && l.targetNodeId === m.link.targetNodeId)
            ? s
            : { noteLinks: [...s.noteLinks, m.link] },
        );
      case 'noteLink.remove':
        return set((s) => ({
          noteLinks: s.noteLinks.filter(
            (l) => !(l.noteId === m.link.noteId && l.targetNodeId === m.link.targetNodeId),
          ),
        }));
      case 'issue.upsert':
        return set((s) => ({ issues: { ...s.issues, [m.issue.ref]: m.issue } }));
      case 'settings.updated':
        return set({ settings: m.settings });
      case 'activity':
        return set((s) => ({ activity: [{ text: m.text, ts: m.ts }, ...s.activity].slice(0, 50) }));
      case 'agent.upsert':
        return set((s) => ({ agents: { ...s.agents, [m.agent.id]: m.agent } }));
      case 'agent.event':
        return set((s) => {
          const list = s.agentEvents[m.event.agentId] ?? [];
          if (list.length && list[list.length - 1]!.id >= m.event.id) return s;
          return {
            agentEvents: { ...s.agentEvents, [m.event.agentId]: [...list, m.event].slice(-MAX_EVENTS) },
          };
        });
      case 'approval.upsert':
        return set((s) => ({
          approvals:
            m.approval.status === 'pending'
              ? { ...s.approvals, [m.approval.id]: m.approval }
              : omit(s.approvals, m.approval.id),
        }));
      case 'policy.upsert':
        return set((s) => ({
          policies: [m.policy, ...s.policies.filter((p) => p.id !== m.policy.id)],
        }));
      case 'policy.remove':
        return set((s) => ({ policies: s.policies.filter((p) => p.id !== m.policyId) }));
      case 'mr.upsert':
        return set((s) => ({ mergeRequests: { ...s.mergeRequests, [m.mr.ref]: m.mr } }));
      case 'context.updated':
        return set((s) => ({ contexts: { ...s.contexts, [m.context.agentId]: m.context } }));
      case 'thread.changed':
        return set((s) => ({
          threadVersion: { ...s.threadVersion, [m.ref]: (s.threadVersion[m.ref] ?? 0) + 1 },
        }));
      case 'error':
        return get().showToast(m.message, { label: 'Ok', run: () => {} });
    }
  },

  setIssues(issues, errors) {
    set((s) => ({
      issues: { ...s.issues, ...Object.fromEntries(issues.map((i) => [i.ref, i])) },
      openIssueRefs: issues.map((i) => i.ref),
      issuesError: errors,
      issuesLoading: false,
    }));
  },
  setIssuesLoading: (v) => set({ issuesLoading: v }),
  setConnection: (c) => set({ connection: c }),
  setSettings: (s) => set({ settings: s }),

  placeIssue(ref, at) {
    const existing = Object.values(get().nodes).find((n) => n.type === 'issue' && n.refId === ref);
    if (existing) return existing.id;
    const id = newId('n');
    const node: CanvasNode = { id, type: 'issue', refId: ref, x: at.x, y: at.y, createdAt: nowIso() };
    set((s) => ({ nodes: { ...s.nodes, [id]: node }, fresh: { ...s.fresh, [id]: true } }));
    send({ type: 'issue.place', nodeId: id, issueRef: ref, x: at.x, y: at.y });
    return id;
  },

  moveNode(id, x, y) {
    const n = get().nodes[id];
    if (!n || (n.x === x && n.y === y)) return;
    set((s) => ({ nodes: { ...s.nodes, [id]: { ...n, x, y } } }));
    send({ type: 'node.move', nodeId: id, x, y });
  },

  createNote(at, linkTo) {
    const noteId = newId('t');
    const nodeId = newId('n');
    const note: Note = { id: noteId, title: 'Nova nota', body: '', isHandoff: false, createdBy: 'user' };
    const node: CanvasNode = {
      id: nodeId,
      type: 'note',
      refId: noteId,
      x: at.x,
      y: at.y,
      createdAt: nowIso(),
    };
    set((s) => ({
      notes: { ...s.notes, [noteId]: note },
      nodes: { ...s.nodes, [nodeId]: node },
      fresh: { ...s.fresh, [nodeId]: true },
    }));
    send({
      type: 'note.create',
      nodeId,
      note: { id: noteId, title: note.title, body: note.body },
      x: at.x,
      y: at.y,
    });
    if (linkTo) get().linkNote(noteId, linkTo);
    return { noteId, nodeId };
  },

  updateNote(noteId, patch) {
    const n = get().notes[noteId];
    if (!n) return;
    set((s) => ({ notes: { ...s.notes, [noteId]: { ...n, ...patch } } }));
    notePatches.set(noteId, { ...notePatches.get(noteId), ...patch });
    clearTimeout(noteTimers.get(noteId));
    noteTimers.set(
      noteId,
      setTimeout(() => get().flushNote(noteId), 400),
    );
  },

  flushNote(noteId) {
    clearTimeout(noteTimers.get(noteId));
    noteTimers.delete(noteId);
    const patch = notePatches.get(noteId);
    notePatches.delete(noteId);
    if (patch) send({ type: 'note.update', noteId, ...patch });
  },

  linkNote(noteId, targetNodeId) {
    const s = get();
    const noteNode = Object.values(s.nodes).find((n) => n.type === 'note' && n.refId === noteId);
    const target = s.nodes[targetNodeId];
    if (!noteNode || !target || !['issue', 'agent'].includes(target.type)) return;
    if (s.noteLinks.some((l) => l.noteId === noteId && l.targetNodeId === targetNodeId)) return;
    const edgeId = newId('e');
    set((st) => ({
      noteLinks: [...st.noteLinks, { noteId, targetNodeId }],
      edges: {
        ...st.edges,
        [edgeId]: { id: edgeId, fromNodeId: noteNode.id, toNodeId: targetNodeId, kind: 'note' },
      },
    }));
    send({ type: 'note.link', edgeId, noteId, targetNodeId });
  },

  unlinkNote(noteId, targetNodeId) {
    const s = get();
    const noteNode = Object.values(s.nodes).find((n) => n.type === 'note' && n.refId === noteId);
    set((st) => ({
      noteLinks: st.noteLinks.filter((l) => !(l.noteId === noteId && l.targetNodeId === targetNodeId)),
      edges: Object.fromEntries(
        Object.entries(st.edges).filter(
          ([, e]) => !(e.kind === 'note' && e.fromNodeId === noteNode?.id && e.toNodeId === targetNodeId),
        ),
      ),
    }));
    send({ type: 'note.unlink', noteId, targetNodeId });
  },

  removeNode(id) {
    const s = get();
    const n = s.nodes[id];
    if (!n) return;
    if (n.type === 'note') get().flushNote(n.refId);
    const label =
      n.type === 'issue'
        ? `Issue #${s.issues[n.refId]?.iid ?? ''} removida do canvas`
        : n.type === 'note'
          ? `Nota "${s.notes[n.refId]?.title ?? ''}" excluída`
          : n.type === 'agent'
            ? `${s.agents[n.refId]?.name ?? 'Agente'} parado e removido do canvas`
            : n.type === 'mr'
              ? `MR !${s.mergeRequests[n.refId]?.iid ?? ''} removido do canvas (continua no GitLab)`
              : 'Item removido do canvas';
    const nodes = omit(s.nodes, id);
    set({
      nodes,
      selected: s.selected === id ? null : s.selected,
      focusId: s.focusId === id ? null : s.focusId,
    });
    send({ type: 'node.remove', nodeId: id });
    pendingUndo = () => send({ type: 'node.restore', nodeId: id });
    get().showToast(label);
  },

  undo() {
    const f = pendingUndo;
    if (!f) return;
    pendingUndo = null;
    set({ toast: null });
    f();
  },

  createAgent({ at, issueRef, repos, instruction, fromNodeId }) {
    const agentId = newId('a');
    const nodeId = newId('n');
    send({
      type: 'agent.create',
      agentId,
      nodeId,
      ...(fromNodeId ? { edgeId: newId('e') } : {}),
      ...(issueRef ? { issueRef } : {}),
      repos: repos ?? [],
      ...(instruction?.trim() ? { instruction: instruction.trim() } : {}),
      maxDepth: 0,
      openMr: true,
      x: at.x,
      y: at.y,
    });
    set((s) => ({ fresh: { ...s.fresh, [nodeId]: true }, selected: nodeId, panel: null }));
    return { agentId, nodeId };
  },
  updateAgent: (agentId, patch) => send({ type: 'agent.update', agentId, ...patch }),
  messageAgent: (agentId, text) => send({ type: 'agent.message', agentId, text }),
  pauseAgent: (agentId) => send({ type: 'agent.pause', agentId }),
  resumeAgent: (agentId) => send({ type: 'agent.resume', agentId }),
  stopAgent: (agentId) => send({ type: 'agent.stop', agentId }),
  decideApproval(approvalId, decision, remember) {
    set((s) => ({ approvals: omit(s.approvals, approvalId) }));
    send({ type: 'approval.decide', approvalId, decision, ...(remember ? { remember } : {}) });
  },
  removePolicy(policyId) {
    set((s) => ({ policies: s.policies.filter((p) => p.id !== policyId) }));
    send({ type: 'policy.remove', policyId });
  },
  contextAdd: (agentId, kind, ref) => send({ type: 'context.add', agentId, kind, ref }),
  contextRemove(agentId, itemId) {
    // some da lista na hora; o bridge manda a visão nova logo em seguida
    set((s) => {
      const c = s.contexts[agentId];
      return c
        ? { contexts: { ...s.contexts, [agentId]: { ...c, items: c.items.filter((i) => i.id !== itemId) } } }
        : s;
    });
    send({ type: 'context.remove', agentId, itemId });
  },
  contextSummarize(agentId, itemId) {
    set((s) => {
      const c = s.contexts[agentId];
      return c
        ? { contexts: { ...s.contexts, [agentId]: { ...c, summarizing: [...c.summarizing, itemId] } } }
        : s;
    });
    send({ type: 'context.summarize', agentId, itemId });
  },
  contextUnsummarize: (agentId, itemId) => send({ type: 'context.unsummarize', agentId, itemId }),
  mergeMr: (ref) => send({ type: 'mr.merge', mrRef: ref }),
  refreshMr: (ref) => send({ type: 'mr.refresh', mrRef: ref }),
  commentMr: (ref, body) => send({ type: 'mr.comment', mrRef: ref, body }),
  commentIssue: (ref, body) => send({ type: 'issue.comment', issueRef: ref, body }),

  select: (id) => set((s) => ({ selected: id, panel: id ? null : s.panel })),
  setPanel: (p) => set({ panel: p, selected: null }),
  setTab: (t) => set({ tab: t }),
  setFilter: (f) => set({ filter: f }),
  setQuery: (q) => set({ query: q }),
  setIssueProject(id) {
    try {
      if (id === null) localStorage.removeItem('ac-issue-project');
      else localStorage.setItem('ac-issue-project', String(id));
    } catch {
      /* armazenamento indisponível: só não lembra */
    }
    set({ issueProject: id });
  },
  setSideHidden(v) {
    try {
      localStorage.setItem('ac-side-hidden', v ? '1' : '0');
    } catch {
      /* armazenamento indisponível: só não lembra */
    }
    set({ sideHidden: v });
  },
  setSideOpen: (v) => set({ sideOpen: v }),
  openFocus: (id) => set((s) => ({ focusId: id, selected: id ?? s.selected, panel: id ? null : s.panel })),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  showToast(msg, action) {
    if (action) pendingUndo = null;
    set({ toast: { id: ++toastSeq, msg, ...(action ? { action } : {}) } });
  },
  hideToast() {
    pendingUndo = null;
    set({ toast: null });
  },
}));

export const hasPendingUndo = () => !!pendingUndo;

// ---------- seletores ----------

export const liveNoteLinks = (s: CanvasState) =>
  s.noteLinks.filter((l) => s.nodes[l.targetNodeId] && noteNodeOf(s, l.noteId));

export const noteNodeOf = (s: CanvasState, noteId: string) =>
  Object.values(s.nodes).find((n) => n.type === 'note' && n.refId === noteId);

export const issueNodeOf = (s: CanvasState, ref: string) =>
  Object.values(s.nodes).find((n) => n.type === 'issue' && n.refId === ref);

export const agentNodeOf = (s: CanvasState, agentId: string) =>
  Object.values(s.nodes).find((n) => n.type === 'agent' && n.refId === agentId);

/** Agentes cujo nó está no canvas. */
export const liveAgents = (s: CanvasState) =>
  Object.values(s.nodes)
    .filter((n) => n.type === 'agent')
    .map((n) => s.agents[n.refId])
    .filter((a): a is Agent => !!a);

export const mrNodeOf = (s: CanvasState, ref: string) =>
  Object.values(s.nodes).find((n) => n.type === 'mr' && n.refId === ref);

/** MRs cujo nó está no canvas. */
export const liveMrs = (s: CanvasState) =>
  Object.values(s.nodes)
    .filter((n) => n.type === 'mr')
    .map((n) => s.mergeRequests[n.refId])
    .filter((m): m is MergeRequest => !!m);

/** MR mais recente aberto pelo agente. */
export const mrOfAgent = (s: CanvasState, agentId: string) =>
  Object.values(s.mergeRequests)
    .filter((m) => m.agentId === agentId)
    .sort((a, b) => b.iid - a.iid)[0];
