import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  agentNoteHeader,
  diffStat,
  isLocalProject,
  mrRef,
  parseIssueRef,
  parseMrRef,
  type IssueComment,
  type MergeProgress,
  type MergeRequest,
  type MrDiffFile,
} from '@agent-canvas/shared';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, edge, mergeRequestCache as mrT, node, repo as repoT } from '../db/schema.ts';
import { diffBranches, isMerged, mergeLocal, originUrl, publishBranch, remoteKind } from '../git/local.ts';
import {
  commitsSince,
  conflictNotice,
  GitError,
  localDiff,
  mergeConflicts,
  pushBranch,
  type MergeConflicts,
} from '../git/worktree.ts';
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
  remoteUrl: r.remoteUrl,
  publishedTo: r.publishedTo,
});

/** Nome curto para logs e mensagens: "MR !12" no GitLab, "revisão #3" num repositório local. */
export const mrName = (m: { projectId: number; iid: number }) =>
  isLocalProject(m.projectId) ? `revisão local #${m.iid}` : `MR !${m.iid}`;

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
  /** Avisado quando estado ou pipeline de um MR mudam (contexto do agente e automações). */
  onChanged: (mr: MergeRequest, prev: MergeRequest) => void = () => {};
  /** Avisado quando um agente abre um MR novo (automação do revisor). */
  onOpened: (mr: MergeRequest) => void = () => {};
  /** Avisado quando um MR de agente passa a ter conflito com a base (automação de conflitos). */
  onConflict: (mr: MergeRequest, conflicts: MergeConflicts) => void = () => {};
  /** Intervalo mínimo entre conferências de conflito do mesmo MR (os testes zeram). */
  conflictCheckMs = 2 * 60_000;
  private conflictCheckedAt = new Map<string, number>();
  /** Arquivos em conflito já avisados, por MR. */
  private conflictSeen = new Map<string, string>();
  /** Sequências de merge por issue (a mais recente de cada uma). */
  private sequences = new Map<string, MergeProgress & { cancel: boolean }>();
  /** Intervalo entre leituras do pipeline e tempo máximo de espera por MR (os testes encurtam). */
  mergePollMs = 15_000;
  mergeTimeoutMs = 45 * 60_000;

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
  async openForAgent(
    agentId: string,
    opts: { title: string; description?: string },
  ): Promise<{ mr: MergeRequest; created: boolean }> {
    const a = this.db.select().from(agentT).where(eq(agentT.id, agentId)).get();
    if (!a?.worktreePath || !a.branch) throw new MrError('O agente ainda não tem worktree.');
    if (a.role === 'reviewer')
      throw new MrError('Revisores não abrem MR: comente os achados com comment_mr.');
    const projectId = a.repos[0];
    const r =
      projectId !== undefined &&
      this.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get();
    if (!r) throw new MrError('Projeto do agente não está entre os escolhidos.');
    const target = r.defaultBranch ?? 'main';
    if (r.local) return this.openLocal(a, r, opts);
    const commits =
      (await commitsSince(a.worktreePath, `origin/${target}`)).length ||
      (await commitsSince(a.worktreePath, target)).length;
    if (!commits)
      throw new MrError('Não há commits novos no branch. Faça commit das mudanças antes de abrir o MR.');

    const demo = this.settings.view().mode === 'demo';
    // com conflito, o MR não entraria: o agente resolve antes de enviar
    const conflicts = await mergeConflicts(a.worktreePath, target, { fetch: !demo });
    if (conflicts?.files.length) throw new MrError(conflictNotice(conflicts, 'Nada foi enviado ainda.'));
    if (!demo) {
      try {
        await pushBranch(a.worktreePath, a.branch);
      } catch (err) {
        throw new MrError(`O push do branch falhou: ${(err as Error).message}`);
      }
    }

    // o agente fix trabalha no MR de outro agente: os commits vão para ele
    const existing = a.mrRef
      ? this.db
          .select()
          .from(mrT)
          .where(
            and(
              eq(mrT.projectId, parseMrRef(a.mrRef).projectId),
              eq(mrT.iid, parseMrRef(a.mrRef).iid),
              eq(mrT.state, 'opened'),
            ),
          )
          .get()
      : this.db
          .select()
          .from(mrT)
          .where(and(eq(mrT.agentId, agentId), eq(mrT.sourceBranch, a.branch), eq(mrT.state, 'opened')))
          .get();
    if (a.mrRef && !existing) throw new MrError('O MR desta tarefa não está mais aberto.');
    if (existing) {
      this.conflictSeen.delete(mrRef(existing.projectId, existing.iid));
      await this.refresh(mrRef(existing.projectId, existing.iid), true);
      return { mr: this.get(mrRef(existing.projectId, existing.iid))!, created: false };
    }

    const issue = a.issueRef ? parseIssueRef(a.issueRef) : null;
    let body = (opts.description ?? '').trim();
    // issue de outro projeto (agente criado por um orquestrador): referência completa
    const issuePath =
      issue && issue.projectId !== projectId ? this.store.cachedIssue(a.issueRef!)?.projectPath : null;
    if (issue && issuePath) {
      // "Closes #12" escrito pelo agente fecharia a issue 12 deste projeto, não a da tarefa
      body = body.replace(
        new RegExp(`\\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?) #${issue.iid}\\b`, 'gi'),
        `$1 ${issuePath}#${issue.iid}`,
      );
    }
    // o agente às vezes já escreve "Closes #iid"; não repete
    const alreadyCloses =
      issue &&
      new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) [\\w./-]*#${issue.iid}\\b`, 'i').test(body);
    const closes = issue && !alreadyCloses ? `\n\nCloses ${issuePath ?? ''}#${issue.iid}` : '';
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
    this.hub.broadcast(
      this.store.logActivity(`${a.name} abriu o MR !${mr.iid} em ${r.name}`, this.wsOf(mr.ref)),
    );
    this.onOpened(mr);
    return { mr, created: true };
  }

  /**
   * Repositório local: não há GitLab para abrir MR. O branch do agente fica para revisão no
   * canvas (diff, comentários para o agente, merge no clone e, se quiser, envio ao remoto).
   * Nada sai da máquina aqui: o push só acontece pelo botão "Enviar", que é do usuário.
   */
  private async openLocal(
    a: typeof agentT.$inferSelect,
    r: typeof repoT.$inferSelect,
    opts: { title: string; description?: string },
  ): Promise<{ mr: MergeRequest; created: boolean }> {
    const target = r.defaultBranch ?? 'main';
    if (!(await commitsSince(a.worktreePath!, target)).length)
      throw new MrError('Não há commits novos no branch. Faça commit das mudanças antes de entregar.');
    const conflicts = await mergeConflicts(a.worktreePath!, target, { local: true });
    if (conflicts?.files.length)
      throw new MrError(conflictNotice(conflicts, 'O branch ainda não foi entregue.'));
    const files = await localDiff(a.worktreePath!, target);
    const existing = this.db
      .select()
      .from(mrT)
      .where(and(eq(mrT.agentId, a.id), eq(mrT.sourceBranch, a.branch!), eq(mrT.state, 'opened')))
      .get();
    const now = nowIso();
    if (existing) {
      this.conflictSeen.delete(mrRef(existing.projectId, existing.iid));
      const row = this.db
        .update(mrT)
        .set({ ...diffStat(files), updatedAt: now, fetchedAt: now })
        .where(and(eq(mrT.projectId, existing.projectId), eq(mrT.iid, existing.iid)))
        .returning()
        .get()!;
      const mr = toMr(row);
      this.hub.broadcast({ type: 'mr.upsert', mr });
      return { mr, created: false };
    }
    const iid =
      (this.db
        .select({ n: sql<number>`max(${mrT.iid})` })
        .from(mrT)
        .where(eq(mrT.projectId, r.gitlabProjectId))
        .get()?.n ?? 0) + 1;
    const row = this.db
      .insert(mrT)
      .values({
        projectId: r.gitlabProjectId,
        iid,
        projectPath: r.pathWithNamespace,
        title: opts.title.trim().slice(0, 250) || a.title,
        description: (opts.description ?? '').trim(),
        sourceBranch: a.branch!,
        targetBranch: target,
        state: 'opened',
        pipelineStatus: 'none',
        webUrl: '',
        ...diffStat(files),
        agentId: a.id,
        issueRef: a.issueRef,
        updatedAt: now,
        fetchedAt: now,
      })
      .returning()
      .get();
    const mr = toMr(row);
    this.placeNode(a.id, mr);
    this.hub.broadcast(
      this.store.logActivity(
        `${a.name} entregou o branch ${a.branch} para revisão em ${r.name}`,
        this.wsOf(mr.ref),
      ),
    );
    this.onOpened(mr);
    return { mr, created: true };
  }

  private repoOfMr(m: MergeRequest) {
    const r = this.db.select().from(repoT).where(eq(repoT.gitlabProjectId, m.projectId)).get();
    if (!r?.localPath) throw new MrError('O repositório desta revisão não está mais no canvas.');
    return { ...r, localPath: r.localPath };
  }

  /** Revisão local: merge feito (aqui ou pelo terminal) e diff atualizado. */
  private async refreshLocal(cur: MergeRequest, force: boolean): Promise<MergeRequest> {
    if (cur.state !== 'opened') return cur;
    let r;
    try {
      r = this.repoOfMr(cur);
    } catch {
      return cur;
    }
    const merged = await isMerged(r.localPath, cur.sourceBranch, cur.targetBranch);
    if (!merged && !force) return cur;
    const files = merged ? [] : await diffBranches(r.localPath, cur.targetBranch, cur.sourceBranch);
    const now = nowIso();
    const row = this.db
      .update(mrT)
      .set({
        ...(merged ? { state: 'merged' as const } : diffStat(files)),
        updatedAt: now,
        fetchedAt: now,
      })
      .where(and(eq(mrT.projectId, cur.projectId), eq(mrT.iid, cur.iid)))
      .returning()
      .get()!;
    const mr = toMr(row);
    this.hub.broadcast({ type: 'mr.upsert', mr });
    if (merged) {
      this.recheckConflicts();
      this.onChanged(mr, cur);
      this.hub.broadcast(
        this.store.logActivity(`${cur.sourceBranch} mergeado em ${cur.targetBranch}`, this.wsOf(mr.ref)),
      );
    }
    return mr;
  }

  /**
   * Botão "Enviar ao GitLab/GitHub" de uma revisão local: push do branch com as credenciais git
   * do usuário; no GitLab o push já abre o MR, no GitHub devolve a página do PR preenchida.
   */
  async publish(ref: string): Promise<MergeRequest> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('Revisão desconhecida.');
    if (!isLocalProject(cur.projectId)) throw new MrError('Este MR já está no GitLab.');
    if (cur.state !== 'opened') throw new MrError('Esta revisão já foi fechada.');
    const r = this.repoOfMr(cur);
    const kind = remoteKind(originUrl(r.localPath), this.settings.view().baseUrl);
    if (!kind) throw new MrError('O repositório não tem remoto: só dá para mergear localmente.');
    const a = cur.agentId ? this.db.select().from(agentT).where(eq(agentT.id, cur.agentId)).get() : null;
    const body = [cur.description, a ? `_Feito por ${a.name} no Agent Canvas._` : '']
      .filter(Boolean)
      .join('\n\n');
    let url: string | null;
    try {
      ({ url } = await publishBranch(r.localPath, {
        branch: cur.sourceBranch,
        base: cur.targetBranch,
        title: cur.title,
        body,
        kind,
      }));
    } catch (err) {
      throw new MrError(err instanceof GitError ? err.message : 'O envio falhou.');
    }
    const row = this.db
      .update(mrT)
      .set({ remoteUrl: url, publishedTo: kind, updatedAt: nowIso() })
      .where(and(eq(mrT.projectId, cur.projectId), eq(mrT.iid, cur.iid)))
      .returning()
      .get()!;
    const mr = toMr(row);
    const where = kind === 'gitlab' ? 'GitLab' : kind === 'github' ? 'GitHub' : 'remoto';
    this.hub.broadcast([
      { type: 'mr.upsert', mr },
      this.store.logActivity(`Branch ${cur.sourceBranch} enviado ao ${where} por você`, this.wsOf(mr.ref)),
    ]);
    return mr;
  }

  /** Workspace do nó do MR (o aberto, se o MR não tiver nó). */
  private wsOf(mrRef: string): string | undefined {
    return this.store.refWorkspace('mr', mrRef) ?? undefined;
  }

  /** Cria o nó do MR ao lado do agente, com a aresta agente → MR. */
  private placeNode(agentId: string, mr: MergeRequest): void {
    const agentNode = this.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'agent'), eq(node.refId, agentId)))
      .get();
    // o MR fica no workspace do agente que o abriu
    const ws = agentNode?.workspaceId ?? this.store.agentWorkspace(agentId);
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'mr' as const,
      refId: mr.ref,
      ...this.store.freeSpot('mr', { x: (agentNode?.x ?? 0) + 460, y: (agentNode?.y ?? 0) + 40 }, ws),
      createdAt: nowIso(),
      workspaceId: ws,
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
    if (isLocalProject(cur.projectId)) return this.refreshLocal(cur, force);
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
    this.onChanged(mr, cur);
    if (fresh.state !== cur.state && fresh.state === 'merged') {
      this.recheckConflicts();
      this.hub.broadcast(this.store.logActivity(`MR !${mr.iid} mergeado`, this.wsOf(mr.ref)));
    } else if (fresh.pipelineStatus !== cur.pipelineStatus && PIPELINE_LABEL[fresh.pipelineStatus])
      this.hub.broadcast(
        this.store.logActivity(
          `Pipeline do MR !${mr.iid} ${PIPELINE_LABEL[fresh.pipelineStatus]}`,
          this.wsOf(mr.ref),
        ),
      );
    return mr;
  }

  /** Rodada do poller: MRs abertos do canvas (webhooks ficam para depois: o app é local). */
  async pollOnce(): Promise<void> {
    for (const mr of this.canvasMrs()) {
      if (mr.state !== 'opened') continue;
      // revisão local: só confere se o merge já foi feito (pelo terminal, por exemplo)
      const fresh = await this.refresh(mr.ref).catch(() => mr);
      if (fresh?.state === 'opened') await this.checkConflicts(fresh).catch(() => {});
    }
  }

  /**
   * MR de agente que passou a ter conflito com a base (outro MR entrou antes): avisa uma vez
   * por conjunto de arquivos; volta a avisar se o conflito sumir e aparecer de novo.
   */
  private async checkConflicts(mr: MergeRequest): Promise<void> {
    if (!mr.agentId) return;
    const last = this.conflictCheckedAt.get(mr.ref) ?? 0;
    if (Date.now() - last < this.conflictCheckMs) return;
    this.conflictCheckedAt.set(mr.ref, Date.now());
    const a = this.db.select().from(agentT).where(eq(agentT.id, mr.agentId)).get();
    if (!a?.worktreePath) return;
    const local = isLocalProject(mr.projectId);
    const c = await mergeConflicts(a.worktreePath, mr.targetBranch, {
      local,
      fetch: !local && this.settings.view().mode !== 'demo',
    });
    if (!c) return;
    const key = c.files.join('\n');
    if (!c.files.length) {
      this.conflictSeen.delete(mr.ref);
      return;
    }
    if (this.conflictSeen.get(mr.ref) === key) return;
    this.conflictSeen.set(mr.ref, key);
    this.hub.broadcast(
      this.store.logActivity(
        `${mrName(mr)} tem conflito com ${c.base} (${c.files.length} arquivo${c.files.length > 1 ? 's' : ''})`,
        this.wsOf(mr.ref),
      ),
    );
    this.onConflict(mr, c);
  }

  /** Uma revisão entrou na base: as outras abertas são conferidas na próxima rodada. */
  private recheckConflicts(): void {
    this.conflictCheckedAt.clear();
  }

  /** Merge pela caixa de Ações. Agentes não têm como chamar isto. */
  async merge(ref: string): Promise<MergeRequest> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    if (isLocalProject(cur.projectId)) return this.mergeLocal(cur);
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
      this.store.logActivity(`MR !${mr.iid} aprovado e mergeado por você`, this.wsOf(mr.ref)),
    ]);
    this.recheckConflicts();
    return mr;
  }

  /** Merge de uma revisão local no clone do usuário (nunca com mudanças não salvas dele). */
  private async mergeLocal(cur: MergeRequest): Promise<MergeRequest> {
    if (cur.state !== 'opened') throw new MrError('Esta revisão já foi fechada.');
    const r = this.repoOfMr(cur);
    const a = cur.agentId ? this.db.select().from(agentT).where(eq(agentT.id, cur.agentId)).get() : null;
    try {
      await mergeLocal(
        r.localPath,
        cur.sourceBranch,
        cur.targetBranch,
        `Merge do branch '${cur.sourceBranch}'${a ? ` (${a.name}, Agent Canvas)` : ''}\n\n${cur.title}`,
      );
    } catch (err) {
      throw new MrError(err instanceof GitError ? err.message : 'O merge falhou.');
    }
    const now = nowIso();
    const row = this.db
      .update(mrT)
      .set({ state: 'merged', updatedAt: now, fetchedAt: now })
      .where(and(eq(mrT.projectId, cur.projectId), eq(mrT.iid, cur.iid)))
      .returning()
      .get()!;
    const mr = toMr(row);
    this.hub.broadcast([
      { type: 'mr.upsert', mr },
      this.store.logActivity(
        `${cur.sourceBranch} mergeado em ${cur.targetBranch} por você (${r.name})`,
        this.wsOf(mr.ref),
      ),
    ]);
    this.recheckConflicts();
    this.onChanged(mr, cur);
    return mr;
  }

  merges(): MergeProgress[] {
    return [...this.sequences.values()].map(({ cancel: _c, ...p }) => p);
  }

  private progress(issueRef: string, patch: Partial<MergeProgress>): void {
    const cur = this.sequences.get(issueRef);
    if (!cur) return;
    Object.assign(cur, patch);
    const { cancel: _c, ...p } = cur;
    this.hub.broadcast({ type: 'merge.progress', progress: p });
  }

  /**
   * Merge em sequência, na ordem escolhida pelo usuário: para cada MR, espera o pipeline
   * passar, faz o merge e só então segue. Para na primeira falha (pipeline com falha, MR
   * fechado, GitLab recusou) ou se o usuário cancelar. Agentes não têm como chamar isto.
   */
  async mergeInOrder(issueRef: string, refs: string[]): Promise<void> {
    const running = this.sequences.get(issueRef);
    if (running && (running.state === 'waiting' || running.state === 'merging'))
      throw new MrError('Já há um merge em sequência para esta issue.');
    for (const ref of refs) if (!this.get(ref)) throw new MrError(`MR ${ref} desconhecido.`);
    this.sequences.set(issueRef, {
      issueRef,
      refs,
      index: 0,
      state: 'waiting',
      message: 'Começando',
      merged: [],
      cancel: false,
    });
    this.progress(issueRef, {});
    const seq = this.sequences.get(issueRef)!;
    const stop = (state: 'failed' | 'cancelled', message: string) => {
      this.progress(issueRef, { state, message });
      this.hub.broadcast(
        this.store.logActivity(
          `Merge em sequência parado: ${message}`,
          this.store.refWorkspace('issue', issueRef) ?? undefined,
        ),
      );
    };
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      const started = Date.now();
      for (;;) {
        if (seq.cancel) return stop('cancelled', 'cancelado por você');
        let mr: MergeRequest | null;
        try {
          mr = await this.refresh(ref, true);
        } catch (err) {
          return stop('failed', `não consegui ler o MR no GitLab (${(err as Error).message})`);
        }
        if (!mr) return stop('failed', `MR ${ref} sumiu`);
        if (mr.state === 'merged') break;
        if (mr.state !== 'opened') return stop('failed', `o MR !${mr.iid} foi fechado`);
        if (mr.pipelineStatus === 'failed' || mr.pipelineStatus === 'canceled')
          return stop(
            'failed',
            `o pipeline do MR !${mr.iid} ${mr.pipelineStatus === 'failed' ? 'falhou' : 'foi cancelado'}`,
          );
        if (
          mr.pipelineStatus === 'success' ||
          mr.pipelineStatus === 'none' ||
          mr.pipelineStatus === 'skipped'
        ) {
          this.progress(issueRef, { index: i, state: 'merging', message: `Mergeando !${mr.iid}` });
          try {
            await this.merge(ref);
          } catch (err) {
            return stop('failed', `o GitLab recusou o merge do !${mr.iid}: ${(err as Error).message}`);
          }
          break;
        }
        if (Date.now() - started > this.mergeTimeoutMs)
          return stop('failed', `o pipeline do MR !${mr.iid} não terminou a tempo`);
        this.progress(issueRef, {
          index: i,
          state: 'waiting',
          message: `Esperando o pipeline do !${mr.iid}`,
        });
        await new Promise((r) => setTimeout(r, this.mergePollMs));
      }
      this.progress(issueRef, { merged: [...seq.merged, ref] });
    }
    this.progress(issueRef, {
      index: refs.length,
      state: 'done',
      message: `${refs.length} MRs mergeados na ordem`,
    });
    this.hub.broadcast(
      this.store.logActivity(
        `Merge em sequência concluído: ${refs.length} MRs`,
        this.store.refWorkspace('issue', issueRef) ?? undefined,
      ),
    );
  }

  cancelMerge(issueRef: string): void {
    const s = this.sequences.get(issueRef);
    if (s && (s.state === 'waiting' || s.state === 'merging')) s.cancel = true;
  }

  async diff(ref: string): Promise<MrDiffFile[]> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    if (isLocalProject(cur.projectId)) {
      const r = this.repoOfMr(cur);
      return diffBranches(r.localPath, cur.targetBranch, cur.sourceBranch);
    }
    const files = await this.settings.client().listMergeRequestDiffs(cur.projectId, cur.iid);
    if (files.length) return files;
    const a = cur.agentId ? this.db.select().from(agentT).where(eq(agentT.id, cur.agentId)).get() : null;
    return a?.worktreePath ? localDiff(a.worktreePath, cur.targetBranch) : [];
  }

  async comments(ref: string): Promise<IssueComment[]> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    if (isLocalProject(cur.projectId)) return [];
    return this.settings.client().listMergeRequestComments(cur.projectId, cur.iid);
  }

  /** Comentário no MR, do usuário ou de um agente (marcado com o cabeçalho do agente). */
  async comment(ref: string, body: string, agentName?: string): Promise<void> {
    const cur = this.get(ref);
    if (!cur) throw new MrError('MR desconhecido.');
    if (isLocalProject(cur.projectId))
      throw new MrError(
        agentName
          ? 'Repositório local: não há discussão de MR. Escreva o resultado na sua resposta final.'
          : 'Repositório local: não há discussão de MR. Mande a mensagem direto ao agente.',
      );
    await this.settings
      .client()
      .commentOnMergeRequest(cur.projectId, cur.iid, agentName ? agentNoteHeader(agentName) + body : body);
    this.hub.broadcast([
      { type: 'thread.changed', target: 'mr', ref },
      this.store.logActivity(`${agentName ?? 'Você'} comentou no MR !${cur.iid}`, this.wsOf(ref)),
    ]);
  }

  async commentIssue(issueRef: string, body: string, agentName?: string): Promise<void> {
    const { projectId, iid } = parseIssueRef(issueRef);
    if (!this.settings.gitlabProjects().some((p) => p.id === projectId))
      throw new MrError('Projeto não escolhido.');
    await this.settings
      .client()
      .commentOnIssue(projectId, iid, agentName ? agentNoteHeader(agentName) + body : body);
    this.hub.broadcast([
      { type: 'thread.changed', target: 'issue', ref: issueRef },
      this.store.logActivity(
        `${agentName ?? 'Você'} comentou na issue #${iid}`,
        this.store.refWorkspace('issue', issueRef) ?? undefined,
      ),
    ]);
  }

  /** MR do agente (ferramenta comment_mr e context.md): o que ele abriu ou o que corrige/revisa. */
  mrOfAgent(agentId: string): MergeRequest | null {
    const a = this.db.select({ mrRef: agentT.mrRef }).from(agentT).where(eq(agentT.id, agentId)).get();
    if (a?.mrRef) return this.get(a.mrRef);
    const r = this.db
      .select()
      .from(mrT)
      .where(eq(mrT.agentId, agentId))
      .all()
      .sort((a, b) => b.iid - a.iid)[0];
    return r ? toMr(r) : null;
  }

  /** MRs abertos do canvas com agente autor (o poller lê a discussão deles). */
  openAgentMrs(): MergeRequest[] {
    return this.canvasMrs().filter((m) => m.state === 'opened' && m.agentId && !isLocalProject(m.projectId));
  }

  /** Último comentário já visto do MR; nulo se a discussão ainda não foi lida. */
  seenComment(ref: string): number | null {
    const { projectId, iid } = parseMrRef(ref);
    return (
      this.db
        .select({ v: mrT.seenCommentId })
        .from(mrT)
        .where(and(eq(mrT.projectId, projectId), eq(mrT.iid, iid)))
        .get()?.v ?? null
    );
  }

  markSeen(ref: string, commentId: number): void {
    const { projectId, iid } = parseMrRef(ref);
    this.db
      .update(mrT)
      .set({ seenCommentId: commentId })
      .where(and(eq(mrT.projectId, projectId), eq(mrT.iid, iid)))
      .run();
  }

  /** Conta mais um agente fix acionado no MR e devolve o total. */
  bumpFixAttempts(ref: string): number {
    const { projectId, iid } = parseMrRef(ref);
    return (
      this.db
        .update(mrT)
        .set({ fixAttempts: sql`${mrT.fixAttempts} + 1` })
        .where(and(eq(mrT.projectId, projectId), eq(mrT.iid, iid)))
        .returning({ n: mrT.fixAttempts })
        .get()?.n ?? 0
    );
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
