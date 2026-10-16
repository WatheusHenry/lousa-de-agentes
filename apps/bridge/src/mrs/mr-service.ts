import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  agentNoteHeader,
  diffStat,
  mrRef,
  parseIssueRef,
  parseMrRef,
  type IssueComment,
  type MergeRequest,
  type MrDiffFile,
} from '@agent-canvas/shared';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, edge, mergeRequestCache as mrT, node, repo as repoT } from '../db/schema.ts';
import { commitsSince, localDiff, pushBranch } from '../git/worktree.ts';
import type { GitLabMr } from '../gitlab/client.ts';
import type { Hub } from '../hub.ts';
import type { SettingsService } from '../settings.ts';

export class MrError extends Error {}

type Row = typeof mrT.$inferSelect;
const nowIso = () => new Date().toISOString();

const toMr = (r: Row): MergeRequest => ({
  ref: mrRef(r.projectId, r.iid),
  projectId: r.projectId,
  projectPath: r.projectPath,
  iid: r.iid,
  title: r.title,
  description: r.description,
  sourceBranch: r.sourceBranch,
  targetBranch: r.targetBranch,
  state: r.state,
  pipelineStatus: r.pipelineStatus as MergeRequest['pipelineStatus'],
  webUrl: r.webUrl,
  additions: r.additions,
  deletions: r.deletions,
  agentId: r.agentId,
  issueRef: r.issueRef,
  updatedAt: r.updatedAt,
});

const PIPELINE_LABEL: Partial<Record<MergeRequest['pipelineStatus'], string>> = {
  success: 'passou',
  failed: 'falhou',
  canceled: 'foi cancelado',
  running: 'está rodando',
};

/**
 * Merge requests abertos pelos agentes: push do branch, criação no GitLab, nó no canvas,
 * acompanhamento do pipeline por polling, comentários e merge (sempre por decisão humana).
 */
export class MrService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Avisado quando estado ou pipeline de um MR mudam (o contexto do agente sugere o log). */
  onChanged: (mr: MergeRequest) => void = () => {};
  private polling = false;

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly store: CanvasStore,
    private readonly settings: SettingsService,
  ) {}

  /** MRs com nó vivo no canvas. */
  canvasMrs(): MergeRequest[] {
    const refs = new Set(
      this.db
        .select({ refId: node.refId })
        .from(node)
        .where(and(eq(node.type, 'mr'), isNull(node.removedAt)))
        .all()
        .map((n) => n.refId),
    );
    return this.db
      .select()
      .from(mrT)
      .all()
      .filter((r) => refs.has(mrRef(r.projectId, r.iid)))
      .map(toMr);
  }

  get(ref: string): MergeRequest | null {
    const { projectId, iid } = parseMrRef(ref);
    const r = this.db
      .select()
      .from(mrT)
      .where(and(eq(mrT.projectId, projectId), eq(mrT.iid, iid)))
      .get();
    return r ? toMr(r) : null;
  }

  /**
   * Ferramenta open_merge_request: envia o branch do agente e abre o MR com "Closes #iid".
   * Se o agente já tem um MR aberto, só envia os commits novos e devolve o mesmo MR.
   */
  async openForAgent(agentId: string, opts: { title: string; description?: string }): Promise<MergeRequest> {
    const a = this.db.select().from(agentT).where(eq(agentT.id, agentId)).get();
    if (!a?.worktreePath || !a.branch) throw new MrError('O agente ainda não tem worktree.');
    const projectId = a.repos[0];
    const r =
      projectId !== undefined &&
      this.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get();
    if (!r) throw new MrError('Projeto do agente não está entre os escolhidos.');
    const target = r.defaultBranch ?? 'main';
    const commits =
      (await commitsSince(a.worktreePath, `origin/${target}`)).length ||
      (await commitsSince(a.worktreePath, target)).length;
    if (!commits)
      throw new MrError('Não há commits novos no branch. Faça commit das mudanças antes de abrir o MR.');

    const demo = this.settings.view().mode === 'demo';
    if (!demo) {
      try {
        await pushBranch(a.worktreePath, a.branch);
      } catch (err) {
        throw new MrError(`O push do branch falhou: ${(err as Error).message}`);
      }
    }

    const existing = this.db
      .select()
      .from(mrT)
      .where(and(eq(mrT.agentId, agentId), eq(mrT.sourceBranch, a.branch), eq(mrT.state, 'opened')))
      .get();
    if (existing) {
      await this.refresh(mrRef(existing.projectId, existing.iid), true);
      return this.get(mrRef(existing.projectId, existing.iid))!;
    }

    const issue = a.issueRef ? parseIssueRef(a.issueRef) : null;
    const body = (opts.description ?? '').trim();
    // o agente às vezes já escreve "Closes #iid"; não repete
    const alreadyCloses =
      issue && new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${issue.iid}\\b`, 'i').test(body);
    const closes = issue && issue.projectId === projectId && !alreadyCloses ? `\n\nCloses #${issue.iid}` : '';
    const description = `${body}${closes}\n\n_Aberto por ${a.name} no Agent Canvas._`.trim();
    const client = this.settings.client();
    // um MR aberto para o branch fora do canvas (ou numa execução anterior) é adotado
    const created =
      (await client.findOpenMergeRequest(projectId!, a.branch).catch(() => null)) ??
      (await client.createMergeRequest(projectId!, {
        sourceBranch: a.branch,
        targetBranch: target,
        title: opts.title.trim().slice(0, 250) || a.title,
        description,
      }));
    const files = await localDiff(a.worktreePath, target);
    const row = this.save(projectId!, r.pathWithNamespace, created, {
      ...diffStat(files),
      agentId,
      issueRef: a.issueRef,
    });
    const mr = toMr(row);
    this.placeNode(agentId, mr);
    this.hub.broadcast(this.store.logActivity(`${a.name} abriu o MR !${mr.iid} em ${r.name}`));
    return mr;
  }

  /** Cria o nó do MR ao lado do agente, com a aresta agente → MR. */
  private placeNode(agentId: string, mr: MergeRequest): void {
    const agentNode = this.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'agent'), eq(node.refId, agentId)))
      .get();
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'mr' as const,
      refId: mr.ref,
      x: (agentNode?.x ?? 0) + 460,
      y: (agentNode?.y ?? 0) + 40,
      createdAt: nowIso(),
    };
    this.db.insert(node).values(n).run();
    this.hub.broadcast([
      { type: 'mr.upsert', mr },
      { type: 'node.upsert', node: n },
    ]);
    if (agentNode) {
      const e = {
        id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        fromNodeId: agentNode.id,
        toNodeId: n.id,
        kind: 'mr' as const,
      };
      this.db.insert(edge).values(e).run();
      this.hub.broadcast({ type: 'edge.upsert', edge: e });
    }
  }

  /** Lê o MR no GitLab; avisa o canvas se pipeline ou estado mudaram. */
  async refresh(ref: string, force = false): Promise<MergeRequest | null> {
    const cur = this.get(ref);
    if (!cur) return null;
    const fresh = await this.settings.client().getMergeRequest(cur.projectId, cur.iid);
    const changed =
      force ||
      fresh.pipelineStatus !== cur.pipelineStatus ||
      fresh.state !== cur.state ||
      fresh.title !== cur.title;
    if (!changed) return cur;
    const row = this.save(cur.projectId, cur.projectPath, fresh, {
      additions: cur.additions,
      deletions: cur.deletions,
      agentId: cur.agentId,
      issueRef: cur.issueRef,
    });
    const mr = toMr(row);
    this.hub.broadcast({ type: 'mr.upsert', mr });
    this.onChanged(mr);
    if (fresh.state !== cur.state && fresh.state === 'merged')
      this.hub.broadcast(this.store.logActivity(`MR !${mr.iid} mergeado`));
    else if (fresh.pipelineStatus !== cur.pipelineStatus && PIPELINE_LABEL[fresh.pipelineStatus])
      this.hub.broadcast(
        this.store.logActivity(`Pipeline do MR !${mr.iid} ${PIPELINE_LABEL[fresh.pipelineStatus]}`),
      );
    return mr;
  }

  /** Polling dos MRs abertos do canvas (webhooks ficam para depois: o app é local). */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const mr of this.canvasMrs()) {
        if (mr.state !== 'opened') continue;
        await this.refresh(mr.ref).catch(() => {});
      }
    } finally {
      this.polling = false;
    }
  }

  startPolling(everyMs = 30_000): void {
    this.stopPolling();
    this.timer = setInterval(() => void this.pollOnce(), everyMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Merge pela caixa de Ações. Agentes não têm como chamar isto. */
  async merge(ref: string): Promise<MergeRequest> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    const merged = await this.settings.client().mergeMergeRequest(cur.projectId, cur.iid);
    const row = this.save(cur.projectId, cur.projectPath, merged, {
      additions: cur.additions,
      deletions: cur.deletions,
      agentId: cur.agentId,
      issueRef: cur.issueRef,
    });
    const mr = toMr(row);
    this.hub.broadcast([
      { type: 'mr.upsert', mr },
      this.store.logActivity(`MR !${mr.iid} aprovado e mergeado por você`),
    ]);
    return mr;
  }

  async diff(ref: string): Promise<MrDiffFile[]> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    const files = await this.settings.client().listMergeRequestDiffs(cur.projectId, cur.iid);
    if (files.length) return files;
    const a = cur.agentId ? this.db.select().from(agentT).where(eq(agentT.id, cur.agentId)).get() : null;
    return a?.worktreePath ? localDiff(a.worktreePath, cur.targetBranch) : [];
  }

  async comments(ref: string): Promise<IssueComment[]> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    return this.settings.client().listMergeRequestComments(cur.projectId, cur.iid);
  }

  /** Comentário no MR, do usuário ou de um agente (marcado com o cabeçalho do agente). */
  async comment(ref: string, body: string, agentName?: string): Promise<void> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    await this.settings
      .client()
      .commentOnMergeRequest(cur.projectId, cur.iid, agentName ? agentNoteHeader(agentName) + body : body);
    this.hub.broadcast([
      { type: 'thread.changed', target: 'mr', ref },
      this.store.logActivity(`${agentName ?? 'Você'} comentou no MR !${cur.iid}`),
    ]);
  }

  async commentIssue(issueRef: string, body: string, agentName?: string): Promise<void> {
    const { projectId, iid } = parseIssueRef(issueRef);
    if (!this.settings.projects().some((p) => p.id === projectId))
      throw new MrError('Projeto não escolhido.');
    await this.settings
      .client()
      .commentOnIssue(projectId, iid, agentName ? agentNoteHeader(agentName) + body : body);
    this.hub.broadcast([
      { type: 'thread.changed', target: 'issue', ref: issueRef },
      this.store.logActivity(`${agentName ?? 'Você'} comentou na issue #${iid}`),
    ]);
  }

  /** MR aberto do agente (para a ferramenta comment_mr). */
  mrOfAgent(agentId: string): MergeRequest | null {
    const r = this.db
      .select()
      .from(mrT)
      .where(eq(mrT.agentId, agentId))
      .all()
      .sort((a, b) => b.iid - a.iid)[0];
    return r ? toMr(r) : null;
  }

  private save(
    projectId: number,
    projectPath: string,
    m: GitLabMr,
    extra: { additions: number; deletions: number; agentId: string | null; issueRef: string | null },
  ): Row {
    const values = {
      projectId,
      iid: m.iid,
      projectPath,
      title: m.title,
      description: m.description,
      sourceBranch: m.sourceBranch,
      targetBranch: m.targetBranch,
      state: m.state,
      pipelineStatus: m.pipelineStatus,
      webUrl: m.webUrl,
      updatedAt: m.updatedAt || nowIso(),
      fetchedAt: nowIso(),
      ...extra,
    };
    return this.db
      .insert(mrT)
      .values(values)
      .onConflictDoUpdate({ target: [mrT.projectId, mrT.iid], set: values })
      .returning()
      .get();
  }
}
