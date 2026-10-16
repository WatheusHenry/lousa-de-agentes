import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  DEFAULT_CONTEXT_BUDGET,
  estimateTokens,
  parseIssueRef,
  parseMrRef,
  type AgentContext,
  type ContextItem,
  type ContextKind,
  type ContextSuggestion,
  type ServerMessage,
} from '@agent-canvas/shared';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, contextItem as ctxT, node, note, noteLink, repo as repoT } from '../db/schema.ts';
import type { Hub } from '../hub.ts';
import type { MrService } from '../mrs/mr-service.ts';
import type { SettingsService } from '../settings.ts';
import { buildContext, type ContextSection } from './builder.ts';
import { excerptLog } from './job-log.ts';
import { listFiles, readRepoFile, repoIndex, searchFiles } from './repo-files.ts';
import type { Summarizer } from './summarize.ts';

export class ContextError extends Error {}

type AgentRow = typeof agentT.$inferSelect;

interface Ref {
  kind: ContextKind;
  ref: string;
  source: 'link' | 'added';
  removable: boolean;
}

interface Resolved {
  label: string;
  heading: string;
  body: string;
  external: boolean;
}

const itemId = (kind: ContextKind, ref: string) => `${kind}:${ref}`;
const splitId = (id: string): { kind: ContextKind; ref: string } => {
  const i = id.indexOf(':');
  return { kind: id.slice(0, i) as ContextKind, ref: id.slice(i + 1) };
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const nowIso = () => new Date().toISOString();

const FENCE_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  json: 'json',
  md: 'md',
  py: 'python',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  sh: 'bash',
  css: 'css',
  html: 'html',
};
const fence = (text: string, lang = '') => {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`;
};

/** Caminhos de arquivo citados num texto (ex.: `src/webhooks/handler.ts`). */
export function citedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /(?:^|[\s`'"([])((?:[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`'"),.:;\]])/gm,
  )) {
    const p = m[1]!.replace(/^\.\//, '');
    if (!/^\d+(\.\d+)+$/.test(p) && !p.includes('://')) out.add(p);
  }
  return [...out];
}

/**
 * Contexto de cada agente (seção 7 do plano): os itens que vêm dos vínculos do canvas (issue,
 * repositório, notas ligadas ao agente ou à issue) mais os escolhidos à mão; os resolvedores
 * que viram cada item em texto; tokens, resumo, sugestões e o context.md.
 */
export class ContextService {
  /** Conteúdo que custa buscar (GitLab, índice do repositório), por pouco tempo. */
  private cache = new Map<string, { at: number; value: Resolved }>();
  private summarizing = new Set<string>();
  private pending = new Map<string, { labels: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  /** O supervisor regrava o context.md e avisa o agente rodando. */
  onChanged: (agentId: string, labels: string[]) => void | Promise<void> = () => {};

  constructor(
    private readonly d: {
      db: Db;
      hub: Hub;
      store: CanvasStore;
      settings: SettingsService;
      mrs: MrService;
      summarizer: Summarizer;
      budget?: number;
      /** Espera antes de avisar o agente (edições de nota chegam em rajadas). */
      debounceMs?: number;
    },
  ) {}

  private get budget() {
    return this.d.budget ?? DEFAULT_CONTEXT_BUDGET;
  }

  private agentRow(agentId: string): AgentRow {
    const a = this.d.db.select().from(agentT).where(eq(agentT.id, agentId)).get();
    if (!a) throw new ContextError('Agente desconhecido.');
    return a;
  }

  /** Pasta de onde ler arquivos do projeto: o worktree do agente ou, antes dele, o clone. */
  private dirFor(a: AgentRow, projectId: number | undefined = a.repos[0]): string | null {
    if (projectId === undefined) return null;
    if (projectId === a.repos[0] && a.worktreePath) return a.worktreePath;
    return (
      this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get()?.localPath ?? null
    );
  }

  // ---------- quais itens ----------

  /** Nós do canvas cujas notas ligadas viram contexto do agente: o dele e o da issue. */
  private targetNodes(a: AgentRow): string[] {
    return this.d.db
      .select()
      .from(node)
      .where(isNull(node.removedAt))
      .all()
      .filter(
        (n) => (n.type === 'agent' && n.refId === a.id) || (n.type === 'issue' && n.refId === a.issueRef),
      )
      .map((n) => n.id);
  }

  private agentNodeId(a: AgentRow): string | null {
    return (
      this.d.db
        .select()
        .from(node)
        .where(and(eq(node.type, 'agent'), eq(node.refId, a.id), isNull(node.removedAt)))
        .get()?.id ?? null
    );
  }

  private refs(a: AgentRow): Ref[] {
    const rows = this.d.db.select().from(ctxT).where(eq(ctxT.agentId, a.id)).all();
    const excluded = new Set(rows.filter((r) => r.excluded).map((r) => itemId(r.kind, r.ref)));
    const out = new Map<string, Ref>();
    const put = (r: Ref) => {
      const id = itemId(r.kind, r.ref);
      if (!excluded.has(id) && !out.has(id)) out.set(id, r);
    };
    if (a.issueRef) put({ kind: 'issue', ref: a.issueRef, source: 'link', removable: false });
    if (a.repos[0] !== undefined)
      put({ kind: 'repo', ref: String(a.repos[0]), source: 'link', removable: false });
    const agentNode = this.agentNodeId(a);
    const targets = this.targetNodes(a);
    if (targets.length) {
      const links = this.d.db.select().from(noteLink).where(inArray(noteLink.targetNodeId, targets)).all();
      const notes = links.length
        ? this.d.db
            .select()
            .from(note)
            .where(inArray(note.id, [...new Set(links.map((l) => l.noteId))]))
            .all()
        : [];
      const liveNotes = new Set(
        this.d.db
          .select()
          .from(node)
          .where(and(eq(node.type, 'note'), isNull(node.removedAt)))
          .all()
          .map((n) => n.refId),
      );
      for (const nt of notes) {
        // a nota de passagem do próprio agente não volta para o contexto dele
        if (nt.createdBy === a.id || !liveNotes.has(nt.id)) continue;
        const direct = links.some((l) => l.noteId === nt.id && l.targetNodeId === agentNode);
        put({ kind: 'note', ref: nt.id, source: direct ? 'added' : 'link', removable: true });
      }
    }
    for (const r of rows) if (r.added) put({ kind: r.kind, ref: r.ref, source: 'added', removable: true });
    return [...out.values()];
  }

  // ---------- resolvedores ----------

  private cached(key: string, ttlMs: number, make: () => Promise<Resolved>): Promise<Resolved> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    return make().then((value) => {
      this.cache.set(key, { at: Date.now(), value });
      return value;
    });
  }

  /** Esquece o conteúdo em cache de um item (ex.: comentário novo na issue). */
  invalidate(kind: ContextKind, ref: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${kind}:${ref}@`)) this.cache.delete(k);
  }

  private async resolve(a: AgentRow, kind: ContextKind, ref: string): Promise<Resolved> {
    switch (kind) {
      case 'note': {
        const nt = this.d.db.select().from(note).where(eq(note.id, ref)).get();
        if (!nt) throw new ContextError('Nota apagada.');
        const by = nt.createdBy === 'user' ? '' : ` (escrita por ${this.agentName(nt.createdBy)})`;
        return {
          label: nt.title,
          heading: `${nt.isHandoff ? 'Nota de passagem' : 'Nota'}: ${nt.title}${by}`,
          body: nt.body || '(vazia)',
          external: false,
        };
      }
      case 'issue':
        return this.cached(`issue:${ref}@`, 60_000, async () => {
          const issue = this.d.store.cachedIssue(ref);
          if (!issue) throw new ContextError('Issue fora do cache. Atualize a lista de issues.');
          const { projectId, iid } = parseIssueRef(ref);
          const comments = await this.d.settings
            .client()
            .listIssueComments(projectId, iid)
            .catch(() => []);
          const body = [
            `Aberta por @${issue.author} em ${issue.projectPath}. Labels: ${issue.labels.join(', ') || 'nenhuma'}. ${issue.webUrl}`,
            '',
            '<issue>',
            issue.description || '(sem descrição)',
            '</issue>',
            ...(comments.length ? ['', '### Comentários', ''] : []),
            ...comments.flatMap((c) => [
              `<comment author="@${c.author}" date="${c.createdAt}">`,
              c.body,
              '</comment>',
              '',
            ]),
          ].join('\n');
          return {
            label: `#${iid} ${issue.title}`,
            heading: `Issue #${iid}: ${issue.title}`,
            body,
            external: true,
          };
        });
      case 'repo': {
        const projectId = Number(ref);
        const r = this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get();
        if (!r) throw new ContextError('Projeto não está entre os escolhidos.');
        const dir = this.dirFor(a, projectId);
        if (!dir) throw new ContextError(`Sem clone local de ${r.pathWithNamespace}.`);
        return this.cached(`repo:${ref}@${dir}`, 20_000, async () => ({
          label: r.name,
          heading: `Repositório ${r.pathWithNamespace} (índice)`,
          body: await repoIndex(dir),
          external: true,
        }));
      }
      case 'file': {
        const dir = this.dirFor(a);
        if (!dir) throw new ContextError('O agente ainda não tem repositório.');
        const text = readRepoFile(dir, ref);
        const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
        return {
          label: ref,
          heading: `Arquivo ${ref}`,
          body: fence(text, FENCE_LANG[ext] ?? ''),
          external: true,
        };
      }
      case 'mr_diff':
        return this.cached(`mr_diff:${ref}@`, 30_000, async () => {
          const { iid } = parseMrRef(ref);
          const files = await this.d.mrs.diff(ref);
          const body = files.length
            ? files
                .map(
                  (f) =>
                    `### ${f.newPath}${f.newFile ? ' (novo)' : f.deletedFile ? ' (removido)' : ''}\n\n${fence(f.diff, 'diff')}`,
                )
                .join('\n\n')
            : '(sem mudanças)';
          return { label: `diff do !${iid}`, heading: `Diff do MR !${iid}`, body, external: true };
        });
      case 'pipeline_log':
        return this.cached(`pipeline_log:${ref}@`, 60_000, async () => {
          const { projectId, iid } = parseMrRef(ref);
          const logs = await this.d.settings.client().failedJobLogs(projectId, iid);
          const body = logs.length
            ? logs
                .map((j) => `### Job ${j.name} (${j.stage}, #${j.jobId})\n\n${fence(excerptLog(j.trace))}`)
                .join('\n\n')
            : '(nenhum job com falha no pipeline mais recente)';
          return {
            label: `log do pipeline !${iid}`,
            heading: `Log do pipeline do MR !${iid}`,
            body,
            external: true,
          };
        });
    }
  }

  private agentName(id: string): string {
    return (
      this.d.db.select({ name: agentT.name }).from(agentT).where(eq(agentT.id, id)).get()?.name ?? 'um agente'
    );
  }

  // ---------- visão e context.md ----------

  /** Itens resolvidos, com resumo aplicado quando ainda vale. */
  private async resolved(a: AgentRow) {
    const rows = new Map(
      this.d.db
        .select()
        .from(ctxT)
        .where(eq(ctxT.agentId, a.id))
        .all()
        .map((r) => [itemId(r.kind, r.ref), r]),
    );
    return Promise.all(
      this.refs(a).map(async (r) => {
        const id = itemId(r.kind, r.ref);
        try {
          const res = await this.resolve(a, r.kind, r.ref);
          const row = rows.get(id);
          const summary = row?.summary && row.contentHash === hash(res.body) ? row.summary : null;
          return { ...r, id, res, summary, error: null as string | null };
        } catch (err) {
          return { ...r, id, res: null, summary: null, error: (err as Error).message };
        }
      }),
    );
  }

  private sectionsOf(list: Awaited<ReturnType<ContextService['resolved']>>): ContextSection[] {
    return list
      .filter((x) => x.res)
      .map((x) => ({
        kind: x.kind,
        heading: x.res!.heading,
        body: x.summary ?? x.res!.body,
        external: x.res!.external,
        summarized: !!x.summary,
      }));
  }

  private header(a: AgentRow) {
    const r =
      a.repos[0] !== undefined
        ? this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, a.repos[0])).get()
        : null;
    return {
      repo: r
        ? {
            pathWithNamespace: r.pathWithNamespace,
            defaultBranch: r.defaultBranch,
            branch: a.branch ?? '(ainda não criado)',
          }
        : null,
      mr: { openOnFinish: a.openMr, current: this.d.mrs.mrOfAgent(a.id) },
      handoff: this.d.settings.automations().handoff,
    };
  }

  /** O context.md do agente, como vai para o worktree. */
  async render(agentId: string): Promise<string> {
    const a = this.agentRow(agentId);
    return buildContext({ ...this.header(a), sections: this.sectionsOf(await this.resolved(a)) });
  }

  async view(agentId: string): Promise<AgentContext> {
    const a = this.agentRow(agentId);
    const list = await this.resolved(a);
    const items: ContextItem[] = list.map((x) => {
      const full = x.res ? estimateTokens(`## ${x.res.heading}\n\n${x.res.body}`) : 0;
      const used = x.summary ? estimateTokens(`## ${x.res!.heading}\n\n${x.summary}`) : full;
      return {
        id: x.id,
        kind: x.kind,
        ref: x.ref,
        label: x.res?.label ?? x.ref,
        source: x.source,
        tokens: used,
        fullTokens: full,
        summarized: !!x.summary,
        removable: x.removable,
        error: x.error,
      };
    });
    const content = buildContext({ ...this.header(a), sections: this.sectionsOf(list) });
    return {
      agentId,
      items,
      totalTokens: estimateTokens(content),
      budget: this.budget,
      suggestions: await this.suggestions(a, list),
      summarizing: [...this.summarizing]
        .filter((k) => k.startsWith(`${agentId}|`))
        .map((k) => k.split('|')[1]!),
    };
  }

  // ---------- sugestões (sem IA, seção 7) ----------

  private async suggestions(
    a: AgentRow,
    list: Awaited<ReturnType<ContextService['resolved']>>,
  ): Promise<ContextSuggestion[]> {
    const have = new Set(list.map((x) => x.id));
    const out: ContextSuggestion[] = [];
    const add = (s: ContextSuggestion) => {
      if (!have.has(itemId(s.kind, s.ref)) && !out.some((o) => o.kind === s.kind && o.ref === s.ref))
        out.push(s);
    };
    const dir = this.dirFor(a);
    const issue = a.issueRef ? this.d.store.cachedIssue(a.issueRef) : null;
    if (dir && issue) {
      const files = new Set(await listFiles(dir));
      for (const p of citedPaths(`${issue.title}\n${issue.description}`)) {
        const match = files.has(p) ? p : [...files].find((f) => f.endsWith(`/${p}`));
        if (match) add({ kind: 'file', ref: match, label: match, why: 'citado na issue' });
        if (out.length >= 5) break;
      }
    }
    if (dir && !have.has(itemId('repo', String(a.repos[0]))) && (await listFiles(dir)).includes('CLAUDE.md'))
      add({ kind: 'file', ref: 'CLAUDE.md', label: 'CLAUDE.md', why: 'instruções do repositório' });
    for (const mr of this.d.mrs.canvasMrs())
      if (mr.agentId === a.id && mr.pipelineStatus === 'failed')
        add({
          kind: 'pipeline_log',
          ref: mr.ref,
          label: `log do pipeline !${mr.iid}`,
          why: 'o pipeline do seu MR falhou',
        });
    // notas ligadas à issue que foram tiradas deste agente
    const excluded = this.d.db
      .select()
      .from(ctxT)
      .where(and(eq(ctxT.agentId, a.id), eq(ctxT.kind, 'note'), eq(ctxT.excluded, true)))
      .all();
    for (const r of excluded) {
      const nt = this.d.db.select().from(note).where(eq(note.id, r.ref)).get();
      if (nt) add({ kind: 'note', ref: nt.id, label: nt.title, why: 'nota ligada à issue' });
    }
    if (issue) {
      const related = this.d.store
        .cachedIssuesOf(issue.projectId)
        .filter((i) => i.ref !== issue.ref && i.labels.some((l) => issue.labels.includes(l)))
        .slice(0, 3);
      for (const i of related)
        add({
          kind: 'issue',
          ref: i.ref,
          label: `#${i.iid} ${i.title}`,
          why: `label em comum: ${i.labels.find((l) => issue.labels.includes(l))}`,
        });
    }
    return out.slice(0, 8);
  }

  /** Arquivos do repositório do agente, para o seletor de contexto. */
  async searchFiles(agentId: string, q: string): Promise<string[]> {
    const dir = this.dirFor(this.agentRow(agentId));
    return dir ? searchFiles(dir, q) : [];
  }

  // ---------- mudanças ----------

  private upsert(agentId: string, kind: ContextKind, ref: string, set: Partial<typeof ctxT.$inferInsert>) {
    this.d.db
      .insert(ctxT)
      .values({ agentId, kind, ref, createdAt: nowIso(), ...set })
      .onConflictDoUpdate({ target: [ctxT.agentId, ctxT.kind, ctxT.ref], set })
      .run();
  }

  async add(agentId: string, kind: ContextKind, ref: string): Promise<void> {
    const a = this.agentRow(agentId);
    if (kind === 'note') {
      // nota vira vínculo no canvas (a aresta aparece e o resto do app já entende)
      const agentNode = this.agentNodeId(a);
      if (!agentNode) throw new ContextError('O agente não está no canvas.');
      this.upsert(agentId, 'note', ref, { excluded: false });
      try {
        this.d.hub.broadcast(
          this.d.store.apply({
            type: 'note.link',
            edgeId: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            noteId: ref,
            targetNodeId: agentNode,
          }),
        );
      } catch (err) {
        throw new ContextError((err as Error).message);
      }
    } else {
      // valida antes de gravar: arquivo que não existe, projeto sem clone…
      await this.resolve(a, kind, ref).catch((err) => {
        throw new ContextError((err as Error).message);
      });
      this.upsert(agentId, kind, ref, { added: true, excluded: false });
    }
    const label = (await this.resolve(a, kind, ref).catch(() => null))?.label ?? ref;
    this.d.hub.broadcast(this.d.store.logActivity(`Contexto "${label}" adicionado a ${a.name}`));
    this.changed(agentId, [`+ ${label}`]);
  }

  async remove(agentId: string, id: string): Promise<void> {
    const a = this.agentRow(agentId);
    const { kind, ref } = splitId(id);
    const item = this.refs(a).find((r) => r.kind === kind && r.ref === ref);
    if (!item) return;
    if (!item.removable)
      throw new ContextError('A issue e o repositório do agente definem a tarefa e não saem do contexto.');
    const label = (await this.resolve(a, kind, ref).catch(() => null))?.label ?? ref;
    const agentNode = this.agentNodeId(a);
    if (kind === 'note' && item.source === 'added' && agentNode) {
      this.d.hub.broadcast(this.d.store.apply({ type: 'note.unlink', noteId: ref, targetNodeId: agentNode }));
      // se a nota também está ligada à issue, ela continuaria entrando: exclui deste agente
      if (this.refs(a).some((r) => r.kind === 'note' && r.ref === ref))
        this.upsert(agentId, kind, ref, { excluded: true });
    } else if (kind === 'note') {
      this.upsert(agentId, kind, ref, { excluded: true });
    } else {
      this.d.db
        .delete(ctxT)
        .where(and(eq(ctxT.agentId, agentId), eq(ctxT.kind, kind), eq(ctxT.ref, ref)))
        .run();
    }
    this.changed(agentId, [`− ${label}`]);
  }

  async summarize(agentId: string, id: string): Promise<void> {
    const a = this.agentRow(agentId);
    const { kind, ref } = splitId(id);
    if (!this.refs(a).some((r) => r.kind === kind && r.ref === ref))
      throw new ContextError('Item fora do contexto.');
    const key = `${agentId}|${id}`;
    if (this.summarizing.has(key)) return;
    const res = await this.resolve(a, kind, ref).catch((err) => {
      throw new ContextError((err as Error).message);
    });
    const before = estimateTokens(res.body);
    if (before < 500) throw new ContextError('Este item já é pequeno.');
    this.summarizing.add(key);
    void this.broadcastView(agentId);
    try {
      const summary = await this.d.summarizer.summarize({ label: res.label, text: res.body });
      this.upsert(agentId, kind, ref, { summary, contentHash: hash(res.body) });
      const after = estimateTokens(summary);
      this.d.hub.broadcast(
        this.d.store.logActivity(
          `"${res.label}" resumido para ${a.name} (${fmtK(before)} → ${fmtK(after)} tokens)`,
        ),
      );
      this.changed(agentId, [`resumo de ${res.label}`]);
    } catch (err) {
      throw new ContextError((err as Error).message);
    } finally {
      this.summarizing.delete(key);
      void this.broadcastView(agentId);
    }
  }

  async unsummarize(agentId: string, id: string): Promise<void> {
    const a = this.agentRow(agentId);
    const { kind, ref } = splitId(id);
    this.d.db
      .update(ctxT)
      .set({ summary: null, contentHash: null })
      .where(and(eq(ctxT.agentId, agentId), eq(ctxT.kind, kind), eq(ctxT.ref, ref)))
      .run();
    const label = (await this.resolve(a, kind, ref).catch(() => null))?.label ?? ref;
    this.changed(agentId, [`${label} completo de novo`]);
  }

  // ---------- gatilhos do canvas ----------

  /** Uma nota mudou: os agentes que a têm no contexto precisam reler. */
  onNoteChanged(noteId: string): void {
    for (const a of this.d.db.select().from(agentT).all())
      if (this.refs(a).some((r) => r.kind === 'note' && r.ref === noteId)) {
        const nt = this.d.db.select().from(note).where(eq(note.id, noteId)).get();
        this.changed(a.id, [`nota "${nt?.title ?? ''}" editada`]);
      }
  }

  /** Vínculos mudaram num nó (nota ligada ou desligada de uma issue ou de um agente). */
  onLinksChanged(targetNodeId: string, label: string, exceptAgentId?: string): void {
    const n = this.d.store.anyNode(targetNodeId);
    if (!n) return;
    const agents =
      n.type === 'agent'
        ? this.d.db.select().from(agentT).where(eq(agentT.id, n.refId)).all()
        : n.type === 'issue'
          ? this.d.db.select().from(agentT).where(eq(agentT.issueRef, n.refId)).all()
          : [];
    for (const a of agents) if (a.id !== exceptAgentId) this.changed(a.id, [label]);
  }

  /**
   * Avisa que o contexto mudou: o painel recebe a visão nova na hora; o agente (context.md e
   * mensagem de releitura) depois de uma pausa curta, juntando as mudanças.
   */
  changed(agentId: string, labels: string[]): void {
    void this.broadcastView(agentId);
    const cur = this.pending.get(agentId);
    if (cur) clearTimeout(cur.timer);
    const set = cur?.labels ?? new Set<string>();
    labels.forEach((l) => set.add(l));
    const timer = setTimeout(() => {
      this.pending.delete(agentId);
      void Promise.resolve(this.onChanged(agentId, [...set])).catch(() => {});
    }, this.d.debounceMs ?? 1500);
    timer.unref?.();
    this.pending.set(agentId, { labels: set, timer });
  }

  async broadcastView(agentId: string): Promise<void> {
    try {
      const context = await this.view(agentId);
      const msg: ServerMessage = { type: 'context.updated', context };
      this.d.hub.broadcast(msg);
    } catch {
      /* agente removido no meio do caminho */
    }
  }

  shutdown(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
