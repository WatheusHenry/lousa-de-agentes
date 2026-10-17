import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  parseIssueRef,
  type Activity,
  type CanvasEdge,
  type CanvasNode,
  type ClientMessage,
  type Issue,
  type Note,
  type NoteLink,
  type ServerMessage,
} from '@agent-canvas/shared';
import type { Db } from '../db/index.ts';
import {
  activity,
  agent,
  browser,
  edge,
  issueCache,
  mergeRequestCache,
  node,
  note,
  noteLink,
} from '../db/schema.ts';

export class CanvasError extends Error {}

const ACTIVITY_LIMIT = 50;
const nowIso = () => new Date().toISOString();

type NodeRow = typeof node.$inferSelect;
const toNode = (r: NodeRow): CanvasNode => ({
  id: r.id,
  type: r.type,
  refId: r.refId,
  x: r.x,
  y: r.y,
  createdAt: r.createdAt,
});

/** Estado do canvas no SQLite: nós, arestas, notas, vínculos e atividade. */
/** Tamanho aproximado de cada cartão no canvas (zoom 100%), para achar lugar livre. */
const NODE_SIZE: Record<CanvasNode['type'], { w: number; h: number }> = {
  issue: { w: 290, h: 175 },
  agent: { w: 404, h: 380 },
  mr: { w: 250, h: 175 },
  note: { w: 290, h: 240 },
  browser: { w: 660, h: 470 },
};

export class CanvasStore {
  constructor(private readonly db: Db) {}

  // ---------- leitura ----------

  liveNodes(): CanvasNode[] {
    return this.db.select().from(node).where(isNull(node.removedAt)).all().map(toNode);
  }

  liveEdges(): CanvasEdge[] {
    const live = new Set(this.liveNodes().map((n) => n.id));
    return this.db
      .select()
      .from(edge)
      .all()
      .filter((e) => live.has(e.fromNodeId) && live.has(e.toNodeId));
  }

  liveNotes(): Note[] {
    const ids = this.liveNodes()
      .filter((n) => n.type === 'note')
      .map((n) => n.refId);
    if (!ids.length) return [];
    return this.db.select().from(note).where(inArray(note.id, ids)).all().map(toNote);
  }

  liveNoteLinks(): NoteLink[] {
    const nodes = this.liveNodes();
    const live = new Set(nodes.map((n) => n.id));
    const liveNotes = new Set(nodes.filter((n) => n.type === 'note').map((n) => n.refId));
    return this.db
      .select()
      .from(noteLink)
      .all()
      .filter((l) => liveNotes.has(l.noteId) && live.has(l.targetNodeId));
  }

  /** Issues em cache referenciadas por nós vivos do canvas. */
  canvasIssues(): Issue[] {
    const refs = this.liveNodes()
      .filter((n) => n.type === 'issue')
      .map((n) => n.refId);
    return refs.map((r) => this.cachedIssue(r)).filter((i): i is Issue => !!i);
  }

  cachedIssue(ref: string): Issue | null {
    const { projectId, iid } = parseIssueRef(ref);
    const row = this.db
      .select()
      .from(issueCache)
      .where(and(eq(issueCache.projectId, projectId), eq(issueCache.iid, iid)))
      .get();
    return row ? toIssue(row) : null;
  }

  /** Issues abertas em cache de um projeto (para sugestões de contexto). */
  cachedIssuesOf(projectId: number): Issue[] {
    return this.db
      .select()
      .from(issueCache)
      .where(and(eq(issueCache.projectId, projectId), eq(issueCache.state, 'opened')))
      .all()
      .map(toIssue);
  }

  recentActivity(): Activity[] {
    return this.db
      .select()
      .from(activity)
      .orderBy(desc(activity.id))
      .limit(ACTIVITY_LIMIT)
      .all()
      .map((a) => ({ text: a.text, ts: a.ts }));
  }

  // ---------- cache de issues ----------

  cacheIssues(issues: Issue[]): void {
    const fetchedAt = nowIso();
    this.db.transaction((tx) => {
      for (const i of issues) {
        const values = {
          projectId: i.projectId,
          iid: i.iid,
          projectPath: i.projectPath,
          title: i.title,
          description: i.description,
          labels: i.labels,
          author: i.author,
          state: i.state,
          updatedAt: i.updatedAt,
          commentCount: i.commentCount,
          webUrl: i.webUrl,
          fetchedAt,
        };
        tx.insert(issueCache)
          .values(values)
          .onConflictDoUpdate({ target: [issueCache.projectId, issueCache.iid], set: values })
          .run();
      }
    });
  }

  // ---------- escrita ----------

  logActivity(text: string): ServerMessage {
    const ts = nowIso();
    this.db.insert(activity).values({ text, ts }).run();
    return { type: 'activity', text, ts };
  }

  /**
   * Aplica uma mensagem do cliente e devolve o que deve ser repassado aos outros clientes.
   * Lança CanvasError quando a mensagem não faz sentido no estado atual.
   */
  apply(msg: ClientMessage): ServerMessage[] {
    switch (msg.type) {
      case 'issue.place':
        return this.placeIssue(msg.nodeId, msg.issueRef, msg.x, msg.y);
      case 'node.move': {
        const r = this.db
          .update(node)
          .set({ x: msg.x, y: msg.y })
          .where(and(eq(node.id, msg.nodeId), isNull(node.removedAt)))
          .returning()
          .get();
        if (!r) throw new CanvasError('Item não encontrado no canvas.');
        return [{ type: 'node.upsert', node: toNode(r) }];
      }
      case 'node.remove':
        return this.removeNode(msg.nodeId);
      case 'node.restore':
        return this.restoreNode(msg.nodeId);
      case 'note.create':
        return this.createNote(msg.nodeId, msg.note, msg.x, msg.y);
      case 'note.update': {
        const set: Partial<typeof note.$inferInsert> = { updatedAt: nowIso() };
        if (msg.title !== undefined) set.title = msg.title;
        if (msg.body !== undefined) set.body = msg.body;
        const r = this.db.update(note).set(set).where(eq(note.id, msg.noteId)).returning().get();
        if (!r) throw new CanvasError('Nota não encontrada.');
        return [{ type: 'note.upsert', note: toNote(r) }];
      }
      case 'note.link':
        return this.linkNote(msg.edgeId, msg.noteId, msg.targetNodeId);
      case 'note.unlink':
        return this.unlinkNote(msg.noteId, msg.targetNodeId);
      default:
        // mensagens de agente, aprovação e regra são tratadas pelo supervisor
        throw new CanvasError('Mensagem não é do canvas.');
    }
  }

  private placeIssue(nodeId: string, ref: string, x: number, y: number): ServerMessage[] {
    const issue = this.cachedIssue(ref);
    if (!issue) throw new CanvasError('Issue desconhecida. Atualize a lista de issues.');
    const existing = this.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'issue'), eq(node.refId, ref)))
      .all();
    const live = existing.find((n) => !n.removedAt);
    if (live) return [{ type: 'node.upsert', node: toNode(live) }];
    // arquivada: volta com agentes, MRs e notas, no lugar onde estava
    if (existing.some((n) => n.archivedAt)) return this.unarchiveIssue(ref);
    // uma issue removida e trazida de novo começa limpa: o nó antigo some de vez
    for (const old of existing) this.purgeNode(old.id);
    const row = this.db
      .insert(node)
      .values({ id: nodeId, type: 'issue', refId: ref, x, y, createdAt: nowIso() })
      .returning()
      .get();
    return [
      { type: 'issue.upsert', issue },
      { type: 'node.upsert', node: toNode(row) },
      this.logActivity(`Issue #${issue.iid} adicionada ao canvas`),
    ];
  }

  /**
   * Nota escrita por um agente (ferramenta write_note). A de passagem é uma por agente: chamar
   * de novo atualiza a mesma. Fica ao lado do agente, ligada a ele por uma aresta e vinculada
   * à issue, para entrar no contexto dos próximos agentes da issue.
   */
  writeAgentNote(o: {
    agentId: string;
    agentName: string;
    title: string;
    body: string;
    handoff: boolean;
    issueRef: string | null;
  }): { noteId: string; created: boolean; out: ServerMessage[] } {
    const agentNode = this.liveNodeByRef('agent', o.agentId);
    const ts = nowIso();
    const existing = o.handoff
      ? this.db
          .select()
          .from(note)
          .where(and(eq(note.createdBy, o.agentId), eq(note.isHandoff, true)))
          .all()
          .find((n) => this.liveNodeByRef('note', n.id))
      : undefined;
    if (existing) {
      const r = this.db
        .update(note)
        .set({ title: o.title, body: o.body, updatedAt: ts })
        .where(eq(note.id, existing.id))
        .returning()
        .get()!;
      return {
        noteId: r.id,
        created: false,
        out: [
          { type: 'note.upsert', note: toNote(r) },
          this.logActivity(`${o.agentName} atualizou a nota de passagem`),
        ],
      };
    }
    const id = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const nodeId = `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const { x, y } = this.freeSpot('note', { x: (agentNode?.x ?? 0) + 460, y: (agentNode?.y ?? 0) + 260 });
    const out: ServerMessage[] = [];
    this.db.transaction((tx) => {
      tx.insert(note)
        .values({
          id,
          title: o.title,
          body: o.body,
          isHandoff: o.handoff,
          createdBy: o.agentId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      tx.insert(node).values({ id: nodeId, type: 'note', refId: id, x, y, createdAt: ts }).run();
    });
    const nt = this.db.select().from(note).where(eq(note.id, id)).get()!;
    const nd = this.db.select().from(node).where(eq(node.id, nodeId)).get()!;
    out.push({ type: 'note.upsert', note: toNote(nt) }, { type: 'node.upsert', node: toNode(nd) });
    if (agentNode) {
      const e: CanvasEdge = {
        id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        fromNodeId: agentNode.id,
        toNodeId: nodeId,
        kind: 'note',
      };
      this.db.insert(edge).values(e).run();
      out.push({ type: 'edge.upsert', edge: e });
    }
    const issueNode = o.issueRef ? this.liveNodeByRef('issue', o.issueRef) : undefined;
    if (issueNode)
      out.push(
        ...this.linkNote(`e_${randomUUID().replace(/-/g, '').slice(0, 16)}`, id, issueNode.id).filter(
          (m) => m.type !== 'activity',
        ),
      );
    const issue = o.issueRef ? this.cachedIssue(o.issueRef) : null;
    out.push(
      this.logActivity(
        `${o.agentName} deixou ${o.handoff ? 'uma nota de passagem' : `a nota "${o.title}"`}${issue && issueNode ? ` na issue #${issue.iid}` : ''}`,
      ),
    );
    return { noteId: id, created: true, out };
  }

  private createNote(
    nodeId: string,
    n: Pick<Note, 'id' | 'title' | 'body'>,
    x: number,
    y: number,
  ): ServerMessage[] {
    const ts = nowIso();
    const row = this.db.transaction((tx) => {
      const nt = tx
        .insert(note)
        .values({
          id: n.id,
          title: n.title,
          body: n.body,
          isHandoff: false,
          createdBy: 'user',
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
      const nd = tx
        .insert(node)
        .values({ id: nodeId, type: 'note', refId: n.id, x, y, createdAt: ts })
        .returning()
        .get();
      return { nt, nd };
    });
    return [
      { type: 'note.upsert', note: toNote(row.nt) },
      { type: 'node.upsert', node: toNode(row.nd) },
      this.logActivity(`Nota "${row.nt.title}" criada`),
    ];
  }

  private linkNote(edgeId: string, noteId: string, targetNodeId: string): ServerMessage[] {
    const noteNode = this.liveNodeByRef('note', noteId);
    const target = this.db
      .select()
      .from(node)
      .where(and(eq(node.id, targetNodeId), isNull(node.removedAt)))
      .get();
    if (!noteNode || !target) throw new CanvasError('Nota ou destino não estão no canvas.');
    if (!['issue', 'agent'].includes(target.type))
      throw new CanvasError('Notas só se ligam a issues e agentes.');
    const dup = this.db
      .select()
      .from(noteLink)
      .where(and(eq(noteLink.noteId, noteId), eq(noteLink.targetNodeId, targetNodeId)))
      .get();
    if (dup) return [];
    const e: CanvasEdge = { id: edgeId, fromNodeId: noteNode.id, toNodeId: targetNodeId, kind: 'note' };
    this.db.transaction((tx) => {
      tx.insert(noteLink).values({ noteId, targetNodeId }).run();
      tx.insert(edge).values(e).run();
    });
    const nt = this.db.select().from(note).where(eq(note.id, noteId)).get()!;
    return [
      { type: 'noteLink.upsert', link: { noteId, targetNodeId } },
      { type: 'edge.upsert', edge: e },
      this.logActivity(`Nota "${nt.title}" vinculada a ${this.describe(target)}`),
    ];
  }

  private unlinkNote(noteId: string, targetNodeId: string): ServerMessage[] {
    const noteNode = this.liveNodeByRef('note', noteId);
    const out: ServerMessage[] = [];
    this.db.transaction((tx) => {
      tx.delete(noteLink)
        .where(and(eq(noteLink.noteId, noteId), eq(noteLink.targetNodeId, targetNodeId)))
        .run();
      if (noteNode) {
        const gone = tx
          .delete(edge)
          .where(
            and(eq(edge.fromNodeId, noteNode.id), eq(edge.toNodeId, targetNodeId), eq(edge.kind, 'note')),
          )
          .returning()
          .all();
        gone.forEach((e) => out.push({ type: 'edge.remove', edgeId: e.id }));
      }
    });
    out.unshift({ type: 'noteLink.remove', link: { noteId, targetNodeId } });
    return out;
  }

  private removeNode(nodeId: string): ServerMessage[] {
    const r = this.db
      .update(node)
      .set({ removedAt: nowIso() })
      .where(and(eq(node.id, nodeId), isNull(node.removedAt)))
      .returning()
      .get();
    if (!r) return [];
    return [
      { type: 'node.remove', nodeId },
      this.logActivity(
        `${this.describe(r, true)} ${r.type === 'note' ? 'excluída' : r.type === 'agent' || r.type === 'mr' || r.type === 'browser' ? 'removido do canvas' : 'removida do canvas'}`,
      ),
    ];
  }

  private restoreNode(nodeId: string): ServerMessage[] {
    const r = this.db.select().from(node).where(eq(node.id, nodeId)).get();
    if (!r || !r.removedAt) return [];
    // a issue já voltou por outro caminho: não duplica
    if (r.type === 'issue' && this.liveNodeByRef('issue', r.refId)) return [];
    this.db.update(node).set({ removedAt: null }).where(eq(node.id, nodeId)).run();
    // arestas, notas e vínculos ficaram guardados; o cliente recebe o estado novo inteiro
    return [this.logActivity('Remoção desfeita')];
  }

  /**
   * Nós que saem do canvas junto com a issue ao arquivar: a issue, os agentes dela (inclusive
   * filhos, correção e revisão, que herdam a issue), os MRs dela e as notas que só servem a esse
   * grupo (as de passagem dos agentes e as ligadas só a eles ou à issue).
   */
  archiveGroup(issueNodeId: string): { issue: NodeRow; nodes: NodeRow[]; agentIds: string[] } {
    const issueNode = this.db
      .select()
      .from(node)
      .where(and(eq(node.id, issueNodeId), eq(node.type, 'issue'), isNull(node.removedAt)))
      .get();
    if (!issueNode) throw new CanvasError('Issue não está no canvas.');
    const ref = issueNode.refId;
    const agentIds = this.db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(agent.issueRef, ref))
      .all()
      .map((a) => a.id);
    const mrRefs = this.db
      .select()
      .from(mergeRequestCache)
      .where(eq(mergeRequestCache.issueRef, ref))
      .all()
      .map((m) => `${m.projectId}!${m.iid}`);
    const live = this.db.select().from(node).where(isNull(node.removedAt)).all();
    const browserIds = agentIds.length
      ? this.db
          .select({ id: browser.id })
          .from(browser)
          .where(inArray(browser.ownerAgentId, agentIds))
          .all()
          .map((b) => b.id)
      : [];
    const group = live.filter(
      (n) =>
        n.id === issueNode.id ||
        (n.type === 'agent' && agentIds.includes(n.refId)) ||
        (n.type === 'mr' && mrRefs.includes(n.refId)) ||
        (n.type === 'browser' && browserIds.includes(n.refId)),
    );
    const ids = new Set(group.map((n) => n.id));
    for (const n of live.filter((x) => x.type === 'note')) {
      const nt = this.db.select().from(note).where(eq(note.id, n.refId)).get();
      const targets = this.db.select().from(noteLink).where(eq(noteLink.noteId, n.refId)).all();
      const byGroupAgent = !!nt && agentIds.includes(nt.createdBy);
      const onlyGroup = targets.length > 0 && targets.every((l) => ids.has(l.targetNodeId));
      if (byGroupAgent || onlyGroup) group.push(n);
    }
    return { issue: issueNode, nodes: group, agentIds };
  }

  /** Arquiva o grupo da issue (some do canvas, não é apagado pela limpeza). */
  archiveIssue(issueNodeId: string): ServerMessage[] {
    const { issue, nodes } = this.archiveGroup(issueNodeId);
    const ts = nowIso();
    this.db
      .update(node)
      .set({ removedAt: ts, archivedAt: ts })
      .where(
        inArray(
          node.id,
          nodes.map((n) => n.id),
        ),
      )
      .run();
    const i = this.cachedIssue(issue.refId);
    return [
      ...nodes.map((n) => ({ type: 'node.remove' as const, nodeId: n.id })),
      this.logActivity(
        `Issue #${i?.iid ?? issue.refId.split('#')[1]} arquivada com ${nodes.length - 1} ite${nodes.length - 1 === 1 ? 'm' : 'ns'}`,
      ),
    ];
  }

  /** Devolve ao canvas o grupo arquivado da issue (mesmo carimbo de arquivamento). */
  unarchiveIssue(ref: string): ServerMessage[] {
    const issueNode = this.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'issue'), eq(node.refId, ref), isNotNull(node.archivedAt)))
      .orderBy(desc(node.archivedAt))
      .get();
    if (!issueNode) throw new CanvasError('Issue não está arquivada.');
    this.db
      .update(node)
      .set({ removedAt: null, archivedAt: null })
      .where(eq(node.archivedAt, issueNode.archivedAt!))
      .run();
    const i = this.cachedIssue(ref);
    return [this.logActivity(`Issue #${i?.iid ?? ref.split('#')[1]} restaurada do arquivo`)];
  }

  /** Issues arquivadas, da mais recente para a mais antiga. */
  archivedIssues(): { issueRef: string; archivedAt: string; items: number }[] {
    const rows = this.db.select().from(node).where(isNotNull(node.archivedAt)).all();
    return rows
      .filter((r) => r.type === 'issue')
      .map((r) => ({
        issueRef: r.refId,
        archivedAt: r.archivedAt!,
        items: rows.filter((x) => x.archivedAt === r.archivedAt).length - 1,
      }))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  /** Apaga de vez os nós removidos há mais de `olderThanMs` (padrão: 1 dia). */
  purgeRemoved(olderThanMs = 86_400_000): number {
    const limit = new Date(Date.now() - olderThanMs).toISOString();
    const old = this.db
      .select()
      .from(node)
      .where(and(isNotNull(node.removedAt), isNull(node.archivedAt), lt(node.removedAt, limit)))
      .all();
    old.forEach((n) => this.purgeNode(n.id));
    // mantém só as últimas entradas de atividade
    const keep = this.db
      .select({ id: activity.id })
      .from(activity)
      .orderBy(desc(activity.id))
      .limit(1)
      .offset(500)
      .get();
    if (keep) this.db.delete(activity).where(lt(activity.id, keep.id)).run();
    return old.length;
  }

  private purgeNode(nodeId: string): void {
    const n = this.db.select().from(node).where(eq(node.id, nodeId)).get();
    if (!n) return;
    this.db.transaction((tx) => {
      tx.delete(edge)
        .where(or(eq(edge.fromNodeId, nodeId), eq(edge.toNodeId, nodeId)))
        .run();
      tx.delete(noteLink).where(eq(noteLink.targetNodeId, nodeId)).run();
      if (n.type === 'note') {
        tx.delete(noteLink).where(eq(noteLink.noteId, n.refId)).run();
        tx.delete(note).where(eq(note.id, n.refId)).run();
      }
      if (n.type === 'browser') tx.delete(browser).where(eq(browser.id, n.refId)).run();
      tx.delete(node).where(eq(node.id, nodeId)).run();
    });
  }

  /**
   * Nó de um navegador (a linha em `browser` já existe). Com `agentNodeId`, liga o agente ao
   * navegador por uma aresta. Sem posição, procura um lugar livre ao lado do agente.
   */
  placeBrowser(o: {
    nodeId: string;
    browserId: string;
    at?: { x: number; y: number };
    agentNodeId?: string;
  }): ServerMessage[] {
    const agentNode = o.agentNodeId
      ? this.db
          .select()
          .from(node)
          .where(and(eq(node.id, o.agentNodeId), isNull(node.removedAt)))
          .get()
      : undefined;
    const at =
      o.at ?? this.freeSpot('browser', { x: (agentNode?.x ?? 0) + 460, y: agentNode?.y ?? 0 });
    const row = this.db
      .insert(node)
      .values({ id: o.nodeId, type: 'browser', refId: o.browserId, x: at.x, y: at.y, createdAt: nowIso() })
      .returning()
      .get();
    const out: ServerMessage[] = [{ type: 'node.upsert', node: toNode(row) }];
    if (agentNode) {
      const e: CanvasEdge = {
        id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        fromNodeId: agentNode.id,
        toNodeId: o.nodeId,
        kind: 'browser',
      };
      this.db.insert(edge).values(e).run();
      out.push({ type: 'edge.upsert', edge: e });
    }
    return out;
  }

  /** Nó vivo de um item pelo tipo e pela referência. */
  liveNodeOf(type: NodeRow['type'], refId: string): CanvasNode | null {
    const r = this.liveNodeByRef(type, refId);
    return r ? toNode(r) : null;
  }

  /**
   * Lugar livre perto de `at` para um nó novo do tipo dado (o bridge cria filhos, MRs, notas de
   * passagem e agentes de correção sem o navegador). Desce em passos de 50 px; se a coluna estiver
   * cheia, tenta as colunas à direita. Tamanhos aproximados dos cartões no zoom 100%.
   */
  freeSpot(type: CanvasNode['type'], at: { x: number; y: number }): { x: number; y: number } {
    const rects = this.liveNodes().map((n) => ({
      x: n.x,
      y: n.y,
      w: NODE_SIZE[n.type].w,
      h: NODE_SIZE[n.type].h,
    }));
    const { w, h } = NODE_SIZE[type];
    const GAP = 30;
    const free = (x: number, y: number) =>
      !rects.some(
        (r) => x < r.x + r.w + GAP && x + w + GAP > r.x && y < r.y + r.h + GAP && y + h + GAP > r.y,
      );
    for (let col = 0; col < 6; col++) {
      const x = at.x + col * (w + GAP * 2);
      for (let i = 0; i < 40; i++) if (free(x, at.y + i * 50)) return { x, y: at.y + i * 50 };
    }
    return at;
  }

  /** Nó pelo id, removido ou não. */
  anyNode(nodeId: string): CanvasNode | null {
    const r = this.db.select().from(node).where(eq(node.id, nodeId)).get();
    return r ? toNode(r) : null;
  }

  private liveNodeByRef(type: NodeRow['type'], refId: string): NodeRow | undefined {
    return this.db
      .select()
      .from(node)
      .where(and(eq(node.type, type), eq(node.refId, refId), isNull(node.removedAt)))
      .get();
  }

  private describe(n: NodeRow, capital = false): string {
    if (n.type === 'issue') {
      const i = this.cachedIssue(n.refId);
      return `${capital ? 'Issue' : 'issue'} #${i?.iid ?? n.refId}`;
    }
    if (n.type === 'note') {
      const nt = this.db.select().from(note).where(eq(note.id, n.refId)).get();
      return `${capital ? 'Nota' : 'nota'} "${nt?.title ?? ''}"`;
    }
    if (n.type === 'agent') {
      const a = this.db.select({ name: agent.name }).from(agent).where(eq(agent.id, n.refId)).get();
      return a?.name ?? (capital ? 'Agente' : 'agente');
    }
    if (n.type === 'mr') return `MR !${n.refId.split('!')[1] ?? n.refId}`;
    if (n.type === 'browser') return capital ? 'Navegador' : 'navegador';
    return capital ? 'Item' : 'item';
  }
}

function toNote(r: typeof note.$inferSelect): Note {
  return { id: r.id, title: r.title, body: r.body, isHandoff: r.isHandoff, createdBy: r.createdBy };
}

function toIssue(r: typeof issueCache.$inferSelect): Issue {
  return {
    ref: `${r.projectId}#${r.iid}`,
    projectId: r.projectId,
    projectPath: r.projectPath,
    iid: r.iid,
    title: r.title,
    description: r.description,
    labels: r.labels,
    author: r.author,
    state: r.state,
    updatedAt: r.updatedAt,
    commentCount: r.commentCount,
    webUrl: r.webUrl,
  };
}
