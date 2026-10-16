import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  type Agent,
  type AgentEvent,
  type AgentEventBody,
  type AgentStatus,
  type Approval,
  type ClientMessage,
} from '@agent-canvas/shared';
import type { ApprovalService } from '../approvals/approval-service.ts';
import { DISALLOWED_TOOLS } from '../approvals/rules.ts';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import { writeContext } from '../context/builder.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, agentEvent, edge, node, repo as repoT } from '../db/schema.ts';
import { createWorktree, slugify } from '../git/worktree.ts';
import type { Hub } from '../hub.ts';
import { APPROVE_TOOL, CANVAS_TOOLS, MCP_SERVER_NAME, type McpAgentContext } from '../mcp/canvas-server.ts';
import type { SettingsService } from '../settings.ts';
import type { AgentProcess, AgentRunner } from './runner.ts';
import { parseLine } from './stream-parser.ts';

export class AgentError extends Error {}

const ROLE_PROMPT = readFileSync(new URL('./roles/main.md', import.meta.url), 'utf8');
const EVENTS_PER_AGENT = 300;
/**
 * O Claude Code descreve uma interrupção ao modelo como "o usuário não quer prosseguir".
 * Na retomada, deixamos claro que foi uma pausa, não uma recusa.
 */
const RESUME_TEXT =
  'Continue de onde parou. O usuário só pausou você: nada foi recusado. Se um comando foi interrompido pela pausa, rode de novo.';
const nowIso = () => new Date().toISOString();

type Row = typeof agentT.$inferSelect;
const toAgent = (r: Row): Agent => ({ ...r });

interface Live {
  proc: AgentProcess;
  /** Mensagens enviadas que ainda não tiveram o evento result. */
  pendingTurns: number;
  pausing: boolean;
  stopping: boolean;
  /** A entrada já foi fechada: o processo está terminando. */
  inputClosed: boolean;
  /** Mensagem que chegou enquanto o processo terminava; vai na retomada logo depois. */
  afterExit: string | null;
}

export interface SupervisorDeps {
  db: Db;
  hub: Hub;
  store: CanvasStore;
  settings: SettingsService;
  approvals: ApprovalService;
  runner: AgentRunner;
  /** Pasta de dados do app (worktrees e configs MCP ficam aqui). */
  home: string;
  bridgePort: number;
  model?: string;
  /** Monta o context.md com os itens de contexto do agente. */
  context: { render(agentId: string): Promise<string> };
}

/** Ciclo de vida dos agentes: worktree, contexto, processo, eventos, status e permissões. */
export class Supervisor {
  private live = new Map<string, Live>();
  private mcpTokens = new Map<string, string>(); // token → agentId
  /** Mudanças de contexto de agentes parados, avisadas na próxima mensagem. */
  private contextNotices = new Map<string, string[]>();
  private closed = false;

  constructor(private readonly d: SupervisorDeps) {
    d.approvals.onChange = (agentId, a) => this.onApproval(agentId, a);
    // agentes que estavam rodando quando o bridge parou: ficam pausados, prontos para retomar
    const stale = d.db
      .select()
      .from(agentT)
      .where(inArray(agentT.status, ['running', 'waiting', 'coordinating']))
      .all();
    for (const a of stale) {
      this.setStatus(a.id, a.sessionId ? 'paused' : 'idle', 'O bridge reiniciou. Retome para continuar.');
    }
  }

  // ---------- leitura ----------

  agents(): Agent[] {
    return this.d.db.select().from(agentT).all().map(toAgent);
  }

  get(id: string): Agent | null {
    const r = this.d.db.select().from(agentT).where(eq(agentT.id, id)).get();
    return r ? toAgent(r) : null;
  }

  /** Últimos eventos de cada agente com nó no canvas. */
  recentEvents(): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const a of this.agents()) out.push(...this.events(a.id, undefined, EVENTS_PER_AGENT).reverse());
    return out;
  }

  /** Eventos de um agente, do mais novo para o mais antigo, antes de `beforeId`. */
  events(agentId: string, beforeId?: number, limit = 200): AgentEvent[] {
    return this.d.db
      .select()
      .from(agentEvent)
      .where(
        and(
          eq(agentEvent.agentId, agentId),
          sql`${agentEvent.type} <> 'raw'`,
          beforeId ? lt(agentEvent.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(agentEvent.id))
      .limit(limit)
      .all()
      .map((e) => ({ id: e.id, agentId: e.agentId, ts: e.ts, body: e.payload as AgentEventBody }));
  }

  rawEvents(agentId: string, limit = 500): string[] {
    return this.d.db
      .select({ raw: agentEvent.raw })
      .from(agentEvent)
      .where(and(eq(agentEvent.agentId, agentId), sql`${agentEvent.raw} is not null`))
      .orderBy(desc(agentEvent.id))
      .limit(limit)
      .all()
      .map((r) => r.raw!)
      .reverse();
  }

  mcpContext(token: string): McpAgentContext | null {
    const id = this.mcpTokens.get(token);
    const a = id && this.get(id);
    if (!a) return null;
    return { agentId: a.id, repoId: a.repos[0] ?? null, worktree: a.worktreePath };
  }

  // ---------- mensagens do cliente ----------

  async handle(msg: Extract<ClientMessage, { type: `agent.${string}` }>): Promise<void> {
    switch (msg.type) {
      case 'agent.create':
        return this.create(msg);
      case 'agent.update':
        return this.update(msg);
      case 'agent.message':
        return this.message(msg.agentId, msg.text);
      case 'agent.pause':
        return this.pause(msg.agentId);
      case 'agent.resume':
        return this.resume(msg.agentId);
      case 'agent.stop':
        return this.stop(msg.agentId, 'Parado por você.');
    }
  }

  private async create(msg: Extract<ClientMessage, { type: 'agent.create' }>): Promise<void> {
    const issue = msg.issueRef ? this.d.store.cachedIssue(msg.issueRef) : null;
    if (msg.issueRef && !issue) throw new AgentError('Issue desconhecida. Atualize a lista de issues.');
    const repos = msg.repos.length ? msg.repos : issue ? [issue.projectId] : [];
    this.checkRepos(repos);
    const count =
      this.d.db
        .select({ n: sql<number>`count(*)` })
        .from(agentT)
        .get()?.n ?? 0;
    const instruction = msg.instruction?.trim() || null;
    const row: Row = {
      id: msg.agentId,
      name: `agente-${count + 1}`,
      role: 'main',
      parentId: null,
      issueRef: msg.issueRef ?? null,
      repos,
      instruction,
      title: issue ? issue.title : instruction ? instruction.slice(0, 80) : 'Agente em branco',
      branch: null,
      worktreePath: null,
      sessionId: null,
      status: 'idle',
      error: null,
      depth: 0,
      maxDepth: msg.maxDepth,
      openMr: msg.openMr,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      createdAt: nowIso(),
    };
    const n = {
      id: msg.nodeId,
      type: 'agent' as const,
      refId: row.id,
      x: msg.x,
      y: msg.y,
      createdAt: nowIso(),
    };
    this.d.db.transaction((tx) => {
      tx.insert(agentT).values(row).run();
      tx.insert(node).values(n).run();
    });
    this.d.hub.broadcast([
      { type: 'agent.upsert', agent: toAgent(row) },
      { type: 'node.upsert', node: n },
    ]);
    if (issue) this.linkIssue(row.id, msg.issueRef!, msg.edgeId);
    this.d.hub.broadcast(
      this.d.store.logActivity(`${row.name} criado${issue ? ` para a issue #${issue.iid}` : ''}`),
    );
    if (instruction) {
      this.event(row.id, { kind: 'user_message', text: instruction });
      await this.launch(row.id, issue ? instructionForIssue(instruction) : instruction, false);
    }
  }

  private update(msg: Extract<ClientMessage, { type: 'agent.update' }>): void {
    const a = this.mustGet(msg.agentId);
    if (a.worktreePath) throw new AgentError('O agente já começou; o repositório não muda mais.');
    const set: Partial<Row> = {};
    if (msg.repos) {
      this.checkRepos(msg.repos);
      set.repos = msg.repos;
    }
    if (msg.issueRef !== undefined) {
      const issue = msg.issueRef ? this.d.store.cachedIssue(msg.issueRef) : null;
      if (msg.issueRef && !issue) throw new AgentError('Issue desconhecida.');
      set.issueRef = msg.issueRef;
      if (issue) {
        set.title = issue.title;
        if (!a.repos.length && !msg.repos) set.repos = [issue.projectId];
      }
    }
    this.save(a.id, set);
    if (msg.issueRef) this.linkIssue(a.id, msg.issueRef);
  }

  async message(agentId: string, text: string): Promise<void> {
    const a = this.mustGet(agentId);
    const l = this.live.get(agentId);
    this.event(agentId, { kind: 'user_message', text });
    if (l && !l.stopping && l.inputClosed) {
      // o processo está terminando: a mensagem vai na retomada, assim que ele sair
      l.afterExit = l.afterExit ? `${l.afterExit}\n\n${text}` : text;
      return;
    }
    if (l && !l.stopping) {
      l.pausing = false;
      l.pendingTurns++;
      l.proc.send(text);
      if (a.status !== 'waiting') this.setStatus(agentId, 'running');
      return;
    }
    if (!a.sessionId) {
      // agente em branco: a primeira mensagem é a instrução
      this.save(agentId, { instruction: text, ...(a.issueRef ? {} : { title: text.slice(0, 80) }) });
      return this.launch(agentId, a.issueRef ? instructionForIssue(text) : text, false);
    }
    return this.launch(agentId, text, true);
  }

  pause(agentId: string): void {
    const l = this.live.get(agentId);
    if (!l) return;
    l.pausing = true;
    this.d.approvals.cancelForAgent(agentId, 'O usuário pausou o agente.');
    l.proc.interrupt();
  }

  async resume(agentId: string): Promise<void> {
    const a = this.mustGet(agentId);
    const l = this.live.get(agentId);
    if (l) {
      if (l.inputClosed && !l.stopping && !l.afterExit) {
        this.event(agentId, { kind: 'user_message', text: 'Continue de onde parou.' });
        l.afterExit = RESUME_TEXT;
      }
      return;
    }
    if (!a.sessionId) throw new AgentError('Este agente ainda não começou. Envie a primeira instrução.');
    this.event(agentId, { kind: 'user_message', text: 'Continue de onde parou.' });
    await this.launch(agentId, RESUME_TEXT, true);
  }

  stop(agentId: string, reason: string): void {
    const l = this.live.get(agentId);
    this.d.approvals.cancelForAgent(agentId, reason);
    const a = this.get(agentId);
    if (!a) return;
    if (l) {
      l.stopping = true;
      l.proc.kill();
    }
    if (!['done', 'stopped', 'error', 'idle'].includes(a.status) || l) {
      this.setStatus(agentId, 'stopped', reason);
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} parado`));
    }
  }

  /** O nó do agente saiu do canvas (remoção suave): o processo para, o histórico fica. */
  onNodeRemoved(agentId: string): void {
    if (this.live.has(agentId)) this.stop(agentId, 'Removido do canvas.');
  }

  shutdown(): void {
    this.closed = true;
    for (const [id, l] of this.live) {
      l.stopping = true;
      l.proc.kill();
      this.setStatus(id, 'paused', 'O bridge foi encerrado. Retome para continuar.');
    }
  }

  // ---------- execução ----------

  private async launch(agentId: string, text: string, resume: boolean): Promise<void> {
    let a = this.mustGet(agentId);
    try {
      const repoId = a.repos[0];
      if (repoId === undefined)
        throw new AgentError(
          'Escolha um repositório: arraste um da aba Repos ou uma issue para cima do agente.',
        );
      const findRepo = () => this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, repoId)).get();
      let r = findRepo();
      if (!r) throw new AgentError('Projeto não está entre os escolhidos nas configurações.');
      if (!r.localPath) {
        // pode ter sido clonado depois de escolher os projetos
        this.d.settings.locateClones();
        r = findRepo()!;
        this.d.hub.broadcast({ type: 'settings.updated', settings: this.d.settings.view() });
      }
      if (!r.localPath)
        throw new AgentError(
          `Não achei o clone de ${r.pathWithNamespace}. Na aba Repos, use Clonar ou Informar caminho.`,
        );

      if (!a.worktreePath) {
        this.setStatus(agentId, 'running', 'preparando o worktree');
        const issue = a.issueRef ? this.d.store.cachedIssue(a.issueRef) : null;
        const branchName = issue
          ? `agent/${issue.iid}-${slugify(issue.title)}`
          : `agent/${slugify(a.title)}-${agentId.slice(-4)}`;
        const wt = await createWorktree({
          repoPath: r.localPath,
          root: join(this.d.home, 'worktrees'),
          agentId,
          branchName,
          defaultBranch: r.defaultBranch,
        });
        a = this.save(agentId, { worktreePath: wt.path, branch: wt.branch });
        this.d.hub.broadcast(this.d.store.logActivity(`${a.name} trabalhando em ${r.name} · ${wt.branch}`));
      }

      await this.refreshContext(a);
      const notices = this.contextNotices.get(agentId);
      if (notices?.length && resume) {
        text = `${text}\n\n(O contexto mudou desde o último turno: ${notices.join('; ')}. Releia .agent-canvas/context.md.)`;
      }
      this.contextNotices.delete(agentId);
      const sessionId = a.sessionId ?? randomUUID();
      const started = resume && this.hasInit(agentId);
      if (!a.sessionId) a = this.save(agentId, { sessionId });

      const proc = this.d.runner.start(
        {
          cwd: a.worktreePath!,
          sessionId,
          resume: started,
          mcpConfigPath: this.writeMcpConfig(agentId),
          permissionPromptTool: APPROVE_TOOL,
          appendSystemPrompt: ROLE_PROMPT,
          allowedTools: [...CANVAS_TOOLS, ...this.d.approvals.allowedTools(repoId)],
          disallowedTools: DISALLOWED_TOOLS,
          ...(this.d.model ? { model: this.d.model } : {}),
        },
        {
          onLine: (line) => this.onLine(agentId, line),
          onExit: (info) => this.onExit(agentId, info),
        },
      );
      this.live.set(agentId, {
        proc,
        pendingTurns: 1,
        pausing: false,
        stopping: false,
        inputClosed: false,
        afterExit: null,
      });
      this.save(agentId, { error: null });
      this.setStatus(agentId, 'running');
      proc.send(started ? text : `${text}\n\nLeia .agent-canvas/context.md antes de começar.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.event(agentId, { kind: 'error', message });
      this.save(agentId, { error: message });
      this.setStatus(agentId, a.sessionId ? 'error' : 'idle');
      if (!(err instanceof AgentError)) throw new AgentError(message);
      throw err;
    }
  }

  /** Regrava o context.md com os itens de contexto do agente (seção 7 do plano). */
  private async refreshContext(a: Agent): Promise<void> {
    writeContext(a.worktreePath!, await this.d.context.render(a.id));
  }

  /**
   * O contexto mudou (item novo, resumo, nota editada): regrava o context.md e pede ao agente
   * que releia. Rodando, a mensagem vai pelo stdin; parado, vai junto da próxima mensagem.
   */
  async contextChanged(agentId: string, labels: string[]): Promise<void> {
    const a = this.get(agentId);
    if (!a?.worktreePath || this.closed) return;
    await this.refreshContext(a);
    const notice = `O contexto foi atualizado: ${labels.join('; ')}. Releia .agent-canvas/context.md.`;
    const l = this.live.get(agentId);
    let notified = false;
    if (l && !l.stopping && !l.pausing) {
      if (l.inputClosed) l.afterExit = l.afterExit ? `${l.afterExit}\n\n${notice}` : notice;
      else {
        l.pendingTurns++;
        l.proc.send(notice);
        if (a.status !== 'waiting') this.setStatus(agentId, 'running');
      }
      notified = true;
    } else if (a.sessionId) {
      const cur = this.contextNotices.get(agentId);
      this.contextNotices.set(agentId, [...(cur ?? []), ...labels]);
    }
    this.event(agentId, { kind: 'context', labels, notified });
  }

  private writeMcpConfig(agentId: string): string {
    let token = [...this.mcpTokens].find(([, id]) => id === agentId)?.[0];
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.mcpTokens.set(token, agentId);
    }
    const dir = join(this.d.home, 'agents', agentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'mcp.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: `http://127.0.0.1:${this.d.bridgePort}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    return file;
  }

  private onLine(agentId: string, line: string): void {
    if (this.closed) return;
    const p = parseLine(line);
    const set: Partial<Row> = {};
    if (p.contextTokens) set.contextTokens = p.contextTokens;
    if (p.turn) {
      const a = this.get(agentId);
      if (a) {
        set.inputTokens = a.inputTokens + p.turn.inputTokens;
        set.outputTokens = a.outputTokens + p.turn.outputTokens;
        // o custo do result é o total da sessão (inclui execuções anteriores retomadas)
        set.costUsd = Math.max(a.costUsd, p.turn.costUsd);
      }
    }
    if (Object.keys(set).length) this.save(agentId, set);
    p.events.forEach((e, i) => this.event(agentId, e, i === 0 ? line : null, p.turn));
    if (!p.events.length && p.turn === undefined && !p.controlResponse) this.rawOnly(agentId, line);

    if (p.turn) this.onTurnEnd(agentId, p.turn);
  }

  private onTurnEnd(agentId: string, turn: NonNullable<ReturnType<typeof parseLine>['turn']>): void {
    const l = this.live.get(agentId);
    const a = this.get(agentId);
    if (!a) return;
    if (l) l.pendingTurns = Math.max(0, l.pendingTurns - 1);
    if (l?.stopping) return;
    if (l?.pausing) {
      closeInput(l);
      this.setStatus(agentId, 'paused');
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} pausado`));
      return;
    }
    if (turn.isError) {
      this.save(agentId, { error: `O turno terminou com erro (${turn.subtype}).` });
      if (l) closeInput(l);
      this.setStatus(agentId, 'error');
      return;
    }
    if (!l || l.pendingTurns === 0) {
      // sem mensagens na fila: o processo termina; a próxima mensagem retoma a sessão
      if (l) closeInput(l);
      this.setStatus(agentId, 'done');
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} concluiu o turno`));
    }
  }

  private onExit(
    agentId: string,
    info: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ) {
    if (this.closed) return;
    const l = this.live.get(agentId);
    this.live.delete(agentId);
    this.d.approvals.cancelForAgent(agentId, 'O processo do agente terminou.');
    if (l?.afterExit && !l.stopping) {
      // erros da retomada já viram evento e status dentro do launch
      void this.launch(agentId, l.afterExit, true).catch(() => {});
      return;
    }
    const a = this.get(agentId);
    if (!a || l?.stopping) return;
    if (l?.pausing) {
      if (a.status !== 'paused') this.setStatus(agentId, 'paused');
      return;
    }
    if (['running', 'waiting', 'coordinating'].includes(a.status)) {
      const tail = info.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      const message = `O processo do claude terminou inesperadamente (código ${info.code ?? info.signal}).${tail ? ' ' + tail : ''}`;
      this.event(agentId, { kind: 'error', message });
      this.save(agentId, { error: message });
      this.setStatus(agentId, 'error');
    }
  }

  private onApproval(agentId: string, ap: Approval): void {
    if (this.closed) return;
    const a = this.get(agentId);
    if (!a) return;
    this.event(agentId, {
      kind: 'permission',
      approvalId: ap.id,
      toolName: ap.toolName,
      summary: ap.summary,
      status: ap.status,
    });
    if (ap.status === 'pending') {
      this.setStatus(agentId, 'waiting');
      this.d.hub.broadcast(
        this.d.store.logActivity(`${a.name} pediu permissão: ${ap.toolName}(${ap.summary})`),
      );
    } else if (a.status === 'waiting' && !this.d.approvals.hasPending(agentId) && this.live.has(agentId)) {
      this.setStatus(agentId, 'running');
    }
  }

  // ---------- utilidades ----------

  private linkIssue(agentId: string, issueRef: string, edgeId?: string): void {
    const issueNode = this.d.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'issue'), eq(node.refId, issueRef), isNull(node.removedAt)))
      .get();
    const agentNode = this.d.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'agent'), eq(node.refId, agentId)))
      .get();
    if (!issueNode || !agentNode) return;
    const exists = this.d.db
      .select()
      .from(edge)
      .where(and(eq(edge.fromNodeId, issueNode.id), eq(edge.toNodeId, agentNode.id)))
      .get();
    if (exists) return;
    const e = {
      id: edgeId ?? randomUUID(),
      fromNodeId: issueNode.id,
      toNodeId: agentNode.id,
      kind: 'issue' as const,
    };
    this.d.db.insert(edge).values(e).run();
    this.d.hub.broadcast({ type: 'edge.upsert', edge: e });
  }

  private checkRepos(repos: number[]): void {
    const chosen = new Set(this.d.settings.projects().map((p) => p.id));
    if (repos.some((r) => !chosen.has(r)))
      throw new AgentError('Projeto não está entre os escolhidos nas configurações.');
  }

  private hasInit(agentId: string): boolean {
    return !!this.d.db
      .select({ id: agentEvent.id })
      .from(agentEvent)
      .where(and(eq(agentEvent.agentId, agentId), eq(agentEvent.type, 'init')))
      .get();
  }

  private mustGet(id: string): Agent {
    const a = this.get(id);
    if (!a) throw new AgentError('Agente não encontrado.');
    return a;
  }

  private save(id: string, set: Partial<Row>): Agent {
    const r = this.d.db.update(agentT).set(set).where(eq(agentT.id, id)).returning().get();
    if (!r) throw new AgentError('Agente não encontrado.');
    const a = toAgent(r);
    this.d.hub.broadcast({ type: 'agent.upsert', agent: a });
    return a;
  }

  private setStatus(id: string, status: AgentStatus, note?: string): void {
    const a = this.get(id);
    if (!a || (a.status === status && !note)) return;
    this.save(id, { status });
    this.event(id, { kind: 'status', status, ...(note ? { note } : {}) });
  }

  private event(
    agentId: string,
    body: AgentEventBody,
    raw: string | null = null,
    turn?: { inputTokens: number; outputTokens: number },
  ): void {
    const ts = nowIso();
    const r = this.d.db
      .insert(agentEvent)
      .values({
        agentId,
        ts,
        type: body.kind,
        payload: body,
        raw,
        inputTokens: turn?.inputTokens ?? null,
        outputTokens: turn?.outputTokens ?? null,
      })
      .returning({ id: agentEvent.id })
      .get();
    this.d.hub.broadcast({ type: 'agent.event', event: { id: r.id, agentId, ts, body } });
  }

  /** Linhas sem evento visível (rate limit, status…) ficam só para o modo "saída bruta". */
  private rawOnly(agentId: string, line: string): void {
    this.d.db
      .insert(agentEvent)
      .values({ agentId, ts: nowIso(), type: 'raw', payload: { kind: 'raw' }, raw: line })
      .run();
  }
}

function closeInput(l: Live): void {
  l.inputClosed = true;
  l.proc.endInput();
}

function instructionForIssue(extra: string): string {
  return `Resolva a issue descrita em .agent-canvas/context.md. Instruções do usuário: ${extra}`;
}
