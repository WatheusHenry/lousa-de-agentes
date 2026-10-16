import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  type Agent,
  type AgentRole,
  type ContextKind,
  type MergeRequest,
  type PlanItem,
  type Question,
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
import { createWorktree, localDiff, slugify } from '../git/worktree.ts';
import type { Hub } from '../hub.ts';
import { APPROVE_TOOL, CANVAS_TOOLS, MCP_SERVER_NAME, type McpAgentContext } from '../mcp/canvas-server.ts';
import type { SettingsService } from '../settings.ts';
import type { QuestionService } from './questions.ts';
import type { AgentProcess, AgentRunner } from './runner.ts';
import { parseLine } from './stream-parser.ts';

export class AgentError extends Error {}

const rolePrompt = (name: string) => readFileSync(new URL(`./roles/${name}.md`, import.meta.url), 'utf8');
/** Prompt de sistema de cada papel. */
const ROLE_PROMPTS: Record<AgentRole, string> = {
  main: rolePrompt('main'),
  orchestrator: rolePrompt('orchestrator'),
  sub: rolePrompt('sub'),
  reviewer: rolePrompt('reviewer'),
  fix: rolePrompt('fix'),
};
/** Estados em que um filho já não está trabalhando (wait_for_agents devolve). */
const SETTLED: AgentStatus[] = ['done', 'error', 'stopped', 'paused', 'idle'];
const EVENTS_PER_AGENT = 300;
/**
 * O Claude Code descreve uma interrupção ao modelo como "o usuário não quer prosseguir".
 * Na retomada, deixamos claro que foi uma pausa, não uma recusa.
 */
const RESUME_TEXT =
  'Continue de onde parou. O usuário só pausou você: nada foi recusado. Se um comando foi interrompido pela pausa, rode de novo.';
/** Mensagem da retomada automática depois de o bridge reiniciar no meio de um turno. */
const RECOVER_TEXT =
  'O Agent Canvas reiniciou no meio do seu turno e o processo foi encerrado; nada foi recusado. Continue de onde parou. Se um comando, pedido de permissão ou pergunta foi interrompido, faça de novo. Se você esperava agentes filhos (wait_for_agents), chame de novo.';
const nowIso = () => new Date().toISOString();

type Row = typeof agentT.$inferSelect;
const toAgent = (r: Row): Agent => ({ ...r });

interface Live {
  proc: AgentProcess;
  /**
   * Há um turno em andamento. Mensagens enviadas durante o turno entram nele (o claude junta
   * tudo num só result), então não se conta um turno por mensagem.
   */
  turnOpen: boolean;
  pausing: boolean;
  stopping: boolean;
  /** A entrada já foi fechada: o processo está terminando. */
  inputClosed: boolean;
  /** Mensagem que chegou enquanto o processo terminava; vai na retomada logo depois. */
  afterExit: string | null;
  /** Tempo máximo do agente (limite do supervisor). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Limites globais do supervisor (seção 8 do plano). */
export interface SupervisorLimits {
  /** Agentes rodando ao mesmo tempo; o resto fica na fila. Coordenando não conta. */
  maxRunning: number;
  /** Tempo máximo de um processo de agente, em minutos; depois disso ele é pausado. */
  maxAgentMinutes: number;
  /** Tokens (entrada + saída) somados de uma árvore de agentes. */
  treeTokenBudget: number;
}

export const DEFAULT_LIMITS: SupervisorLimits = {
  maxRunning: 4,
  maxAgentMinutes: 60,
  treeTokenBudget: 5_000_000,
};

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
  context: {
    render(agentId: string): Promise<string>;
    /** Itens que o sub-agente recebe ao nascer (plano do pai e o que o pai passou). */
    seed(agentId: string, items: { kind: ContextKind; ref: string }[]): void;
  };
  questions: QuestionService;
  /** MR do agente, para o resumo do wait_for_agents. */
  mrOfAgent?: (agentId: string) => MergeRequest | null;
  limits?: Partial<SupervisorLimits>;
}

/** Fila de agentes esperando vaga para rodar. */
interface Queued {
  agentId: string;
  text: string;
  resume: boolean;
}

/** Ciclo de vida dos agentes: worktree, contexto, processo, eventos, status e permissões. */
export class Supervisor {
  private live = new Map<string, Live>();
  private mcpTokens = new Map<string, string>(); // token → agentId
  /** Mudanças de contexto de agentes parados, avisadas na próxima mensagem. */
  private contextNotices = new Map<string, string[]>();
  private queue: Queued[] = [];
  /** wait_for_agents em andamento: quem espera, quais filhos e como responder. */
  private waiters: { callerId: string; ids: string[]; done: (cancelled: string | null) => void }[] = [];
  private readonly limits: SupervisorLimits;
  private closed = false;
  /** Agentes começando (worktree e contexto sendo preparados): já ocupam vaga no limite. */
  private starting = new Set<string>();
  /** Agentes que trabalhavam quando o bridge parou (crash ou desligamento): `recover()` decide. */
  private interrupted: string[] = [];

  constructor(private readonly d: SupervisorDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...d.limits };
    d.approvals.onChange = (agentId, a) => this.onApproval(agentId, a);
    d.questions.onChange = (q) => this.onQuestion(q);
    // agentes que estavam trabalhando quando o bridge parou: recover() retoma ou pausa
    this.interrupted = d.db
      .select({ id: agentT.id })
      .from(agentT)
      .where(inArray(agentT.status, ['running', 'waiting', 'coordinating', 'queued']))
      .all()
      .map((a) => a.id);
  }

  /**
   * Depois de o bridge subir (o MCP precisa estar no ar): retoma com --resume os agentes
   * interrompidos. O que não pode voltar (worktree apagado, sessão que o claude não acha) fica
   * como erro. Com `auto` desligado, ficam pausados para o usuário retomar.
   */
  async recover(auto = true): Promise<void> {
    const ids = this.interrupted;
    this.interrupted = [];
    if (ids.length)
      this.d.hub.broadcast(
        this.d.store.logActivity(
          auto
            ? `O bridge reiniciou: retomando ${ids.length} agente${ids.length > 1 ? 's' : ''}`
            : `O bridge reiniciou: ${ids.length} agente${ids.length > 1 ? 's' : ''} pausado${ids.length > 1 ? 's' : ''}`,
        ),
      );
    for (const id of ids) {
      const a = this.get(id);
      if (!a || this.live.has(id)) continue;
      const started = !!a.sessionId && this.hasInit(id);
      if (!auto) {
        this.d.approvals.cancelForAgent(id, 'O bridge reiniciou.');
        this.d.questions.cancelForAgent(id);
        this.setStatus(id, started ? 'paused' : 'idle', 'O bridge reiniciou. Retome para continuar.');
        continue;
      }
      if (a.worktreePath && !existsSync(a.worktreePath)) {
        const message = `O bridge reiniciou e a pasta de trabalho ${a.worktreePath} não existe mais: não dá para retomar.`;
        this.d.approvals.cancelForAgent(id, message);
        this.d.questions.cancelForAgent(id);
        this.event(id, { kind: 'error', message });
        this.save(id, { error: message });
        this.setStatus(id, 'error');
        continue;
      }
      // erros do launch (claude ausente, sessão perdida) viram evento e status lá dentro
      if (started) {
        this.event(id, { kind: 'status', status: a.status, note: 'retomando depois do reinício do bridge' });
        await this.launch(id, RECOVER_TEXT, true).catch(() => {});
      } else if (a.instruction) {
        const text = a.issueRef && a.depth === 0 ? instructionForIssue(a.instruction) : a.instruction;
        await this.launch(id, text, false).catch(() => {});
      } else this.setStatus(id, 'idle');
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
    // mais de um repositório: um orquestrador divide o trabalho em um agente por repositório
    const role: AgentRole = repos.length > 1 ? 'orchestrator' : 'main';
    const row: Row = {
      id: msg.agentId,
      name: `agente-${count + 1}`,
      role,
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
      plan: null,
      mrRef: null,
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
      this.d.store.logActivity(
        `${row.name} criado${role === 'orchestrator' ? ' como orquestrador' : ''}${issue ? ` para a issue #${issue.iid}` : ''}`,
      ),
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
      set.role = msg.repos.length > 1 ? 'orchestrator' : 'main';
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
      l.turnOpen = true;
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
    this.d.questions.cancelForAgent(agentId);
    this.cancelWait(agentId, 'A espera foi cancelada: o usuário pausou você.');
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
    this.d.questions.cancelForAgent(agentId);
    this.cancelWait(agentId, 'A espera foi cancelada: o agente foi parado.');
    this.queue = this.queue.filter((q) => q.agentId !== agentId);
    const a = this.get(agentId);
    if (!a) return;
    if (l) {
      l.stopping = true;
      l.proc.kill();
    }
    if (!['done', 'stopped', 'error', 'idle'].includes(a.status) || l || a.status === 'queued') {
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
    this.queue = [];
    for (const w of this.waiters) w.done('O bridge foi encerrado.');
    this.waiters = [];
    // o status fica como está: na próxima subida, recover() retoma estes agentes
    for (const l of this.live.values()) {
      l.stopping = true;
      if (l.timer) clearTimeout(l.timer);
      l.proc.kill();
    }
  }

  // ---------- execução ----------

  /** Processos rodando que contam no limite (coordenando, esperando os filhos, não conta). */
  private runningCount(): number {
    let n = 0;
    for (const id of this.live.keys()) if (this.get(id)?.status !== 'coordinating') n++;
    for (const id of this.starting) if (!this.live.has(id)) n++;
    return n;
  }

  /** Começa o próximo da fila, se houver vaga. */
  private drainQueue(): void {
    while (this.queue.length && this.runningCount() < this.limits.maxRunning && !this.closed) {
      const q = this.queue.shift()!;
      void this.launch(q.agentId, q.text, q.resume).catch(() => {});
    }
  }

  /** Tokens (entrada + saída) somados da árvore do agente, a partir da raiz. */
  treeTokens(agentId: string): number {
    const all = this.agents();
    let root = all.find((a) => a.id === agentId);
    while (root?.parentId) root = all.find((a) => a.id === root!.parentId) ?? root;
    if (!root) return 0;
    const ids = new Set([root.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of all)
        if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {
          ids.add(a.id);
          grew = true;
        }
    }
    return all.filter((a) => ids.has(a.id)).reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
  }

  private repoRow(projectId: number) {
    const find = () => this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get();
    let r = find();
    if (!r) throw new AgentError('Projeto não está entre os escolhidos nas configurações.');
    if (!r.localPath) {
      // pode ter sido clonado depois de escolher os projetos
      this.d.settings.locateClones();
      r = find()!;
      this.d.hub.broadcast({ type: 'settings.updated', settings: this.d.settings.view() });
    }
    if (!r.localPath)
      throw new AgentError(
        `Não achei o clone de ${r.pathWithNamespace}. Na aba Repos, use Clonar ou Informar caminho.`,
      );
    return r as typeof r & { localPath: string };
  }

  private async launch(agentId: string, text: string, resume: boolean): Promise<void> {
    let a = this.mustGet(agentId);
    try {
      const repoId = a.repos[0];
      if (repoId === undefined)
        throw new AgentError(
          'Escolha um repositório: arraste um da aba Repos ou uma issue para cima do agente.',
        );
      if (this.treeTokens(agentId) > this.limits.treeTokenBudget)
        throw new AgentError(
          `A árvore deste agente passou do orçamento de ${Math.round(this.limits.treeTokenBudget / 1000)}k tokens (AGENT_CANVAS_TREE_TOKEN_BUDGET).`,
        );
      // o agente fix trabalha no worktree do autor: um de cada vez
      const sharing = a.worktreePath
        ? [...this.live.keys()].find(
            (id) => id !== agentId && this.busy(id) && this.get(id)?.worktreePath === a.worktreePath,
          )
        : undefined;
      if (sharing)
        throw new AgentError(
          `${this.get(sharing)!.name} está trabalhando no mesmo worktree. Espere ele terminar.`,
        );
      if (this.runningCount() >= this.limits.maxRunning) {
        // sem vaga: entra na fila e começa quando outro agente terminar
        this.queue.push({ agentId, text, resume });
        this.setStatus(agentId, 'queued', `na fila: ${this.limits.maxRunning} agentes já estão rodando`);
        return;
      }
      this.starting.add(agentId);
      const repos = a.repos.map((id) => this.repoRow(id));
      const r = repos[0]!;

      if (!a.worktreePath) {
        this.setStatus(
          agentId,
          'running',
          a.role === 'orchestrator' ? 'preparando o espaço de trabalho' : 'preparando o worktree',
        );
        if (a.role === 'orchestrator') {
          // o orquestrador não escreve código: pasta própria e leitura dos clones (--add-dir)
          const ws = join(this.d.home, 'workspaces', agentId);
          mkdirSync(ws, { recursive: true });
          a = this.save(agentId, { worktreePath: ws });
          this.d.hub.broadcast(
            this.d.store.logActivity(`${a.name} coordenando ${repos.map((x) => x.name).join(', ')}`),
          );
        } else {
          const issue = a.issueRef ? this.d.store.cachedIssue(a.issueRef) : null;
          const parent = a.parentId ? this.get(a.parentId) : null;
          // sub-agente no mesmo repositório do pai: branch a partir do branch do pai
          const fromParent = a.role === 'sub' && parent?.branch && parent.repos[0] === repoId;
          // revisor: branch a partir do branch do MR, só para ler e rodar testes
          const reviewed = a.role === 'reviewer' ? this.d.mrOfAgent?.(agentId) : null;
          const localBase = fromParent ? parent.branch : (reviewed?.sourceBranch ?? null);
          const branchName = fromParent
            ? `${parent.branch}-${slugify(a.title, 3)}`
            : reviewed
              ? `${reviewed.sourceBranch}-review`
              : issue
                ? `agent/${issue.iid}-${slugify(issue.title)}`
                : `agent/${slugify(a.title)}-${agentId.slice(-4)}`;
          const wt = await createWorktree({
            repoPath: r.localPath,
            root: join(this.d.home, 'worktrees'),
            agentId,
            branchName,
            defaultBranch: localBase ?? r.defaultBranch,
            ...(localBase ? { localBase: true } : {}),
          });
          a = this.save(agentId, { worktreePath: wt.path, branch: wt.branch });
          this.d.hub.broadcast(this.d.store.logActivity(`${a.name} trabalhando em ${r.name} · ${wt.branch}`));
        }
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
          appendSystemPrompt: ROLE_PROMPTS[a.role],
          allowedTools: [...CANVAS_TOOLS, ...this.d.approvals.allowedTools(repoId)],
          disallowedTools: DISALLOWED_TOOLS,
          ...(a.role === 'orchestrator' ? { addDirs: repos.map((x) => x.localPath) } : {}),
          ...(this.d.model ? { model: this.d.model } : {}),
        },
        {
          onLine: (line) => this.onLine(agentId, line),
          onExit: (info) => this.onExit(agentId, info),
        },
      );
      const timer = setTimeout(() => {
        const cur = this.get(agentId);
        if (!this.live.has(agentId) || cur?.status === 'coordinating') return;
        this.event(agentId, {
          kind: 'error',
          message: `Passou do tempo máximo de ${this.limits.maxAgentMinutes} min (AGENT_CANVAS_MAX_AGENT_MINUTES). Pausado; retome para continuar.`,
        });
        this.pause(agentId);
      }, this.limits.maxAgentMinutes * 60_000);
      timer.unref?.();
      this.live.set(agentId, {
        proc,
        turnOpen: true,
        pausing: false,
        stopping: false,
        inputClosed: false,
        afterExit: null,
        timer,
      });
      this.starting.delete(agentId);
      this.save(agentId, { error: null });
      this.setStatus(agentId, 'running');
      proc.send(started ? text : `${text}\n\nLeia .agent-canvas/context.md antes de começar.`);
    } catch (err) {
      this.starting.delete(agentId);
      queueMicrotask(() => this.drainQueue());
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
    const file = join(a.worktreePath, '.agent-canvas', 'context.md');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    await this.refreshContext(a);
    // nada mudou no que o agente lê (ex.: a nota de passagem dele mesmo): não interrompe
    if (readFileSync(file, 'utf8') === before) return;
    const notice = `O contexto foi atualizado: ${labels.join('; ')}. Releia .agent-canvas/context.md.`;
    const l = this.live.get(agentId);
    let notified = false;
    if (l && !l.stopping && !l.pausing) {
      if (l.inputClosed) l.afterExit = l.afterExit ? `${l.afterExit}\n\n${notice}` : notice;
      else {
        l.turnOpen = true;
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
    else {
      const l = this.live.get(agentId);
      if (
        l &&
        !l.turnOpen &&
        !l.stopping &&
        p.events.some((e) => e.kind === 'text' || e.kind === 'tool_use')
      ) {
        l.turnOpen = true;
        this.setStatus(agentId, 'running');
      }
    }
  }

  private onTurnEnd(agentId: string, turn: NonNullable<ReturnType<typeof parseLine>['turn']>): void {
    const l = this.live.get(agentId);
    const a = this.get(agentId);
    if (!a) return;
    if (l) l.turnOpen = false;
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
    // o processo termina; a próxima mensagem retoma a sessão. Se uma mensagem chegou no
    // instante do result, o claude ainda a processa antes de sair e onLine reabre o turno.
    if (l) closeInput(l);
    this.setStatus(agentId, 'done');
    this.d.hub.broadcast(this.d.store.logActivity(`${a.name} concluiu o turno`));
  }

  private onExit(
    agentId: string,
    info: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ) {
    if (this.closed) return;
    const l = this.live.get(agentId);
    this.live.delete(agentId);
    if (l?.timer) clearTimeout(l.timer);
    this.d.approvals.cancelForAgent(agentId, 'O processo do agente terminou.');
    this.d.questions.cancelForAgent(agentId);
    this.cancelWait(agentId, 'O processo terminou durante a espera.');
    queueMicrotask(() => this.drainQueue());
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
    } else if (
      a.status === 'waiting' &&
      !this.d.approvals.hasPending(agentId) &&
      !this.d.questions.hasPending(agentId) &&
      this.live.has(agentId)
    ) {
      this.setStatus(agentId, 'running');
    }
  }

  // ---------- orquestração (ferramentas do MCP do canvas) ----------

  /**
   * spawn_agent: cria um filho num repositório, com uma tarefa. Recusa além da profundidade
   * escolhida pelo usuário. O filho herda a issue, as notas ligadas aos agentes acima dele e o
   * plano do pai, e começa na hora (ou entra na fila).
   */
  async spawn(
    parentId: string,
    input: { repo: string; task: string; context?: { kind: ContextKind; ref: string }[] },
  ): Promise<Agent> {
    const p = this.mustGet(parentId);
    if (p.depth >= p.maxDepth)
      throw new AgentError(
        p.maxDepth === 0
          ? 'O usuário não liberou sub-agentes para esta tarefa. Faça o trabalho você mesmo.'
          : `Profundidade máxima (${p.maxDepth}) atingida: faça esta parte você mesmo.`,
      );
    if (this.treeTokens(parentId) > this.limits.treeTokenBudget)
      throw new AgentError('A árvore de agentes passou do orçamento de tokens; termine com o que já tem.');
    const want = input.repo.trim().toLowerCase();
    const project = this.d.settings
      .projects()
      .find(
        (x) =>
          String(x.id) === want ||
          x.name.toLowerCase() === want ||
          x.pathWithNamespace.toLowerCase() === want,
      );
    if (!project)
      throw new AgentError(
        `Repositório "${input.repo}" não está entre os escolhidos. Opções: ${this.d.settings
          .projects()
          .map((x) => x.name)
          .join(', ')}.`,
      );
    if (p.role === 'orchestrator' && !p.repos.includes(project.id))
      throw new AgentError(`${project.name} não está entre os repositórios desta tarefa.`);
    const count =
      this.d.db
        .select({ n: sql<number>`count(*)` })
        .from(agentT)
        .get()?.n ?? 0;
    const siblings = this.d.db.select().from(agentT).where(eq(agentT.parentId, parentId)).all().length;
    const id = `a_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const role: AgentRole = p.role === 'orchestrator' || project.id !== p.repos[0] ? 'main' : 'sub';
    const task = input.task.trim();
    const row: Row = {
      id,
      name: `agente-${count + 1}`,
      role,
      parentId,
      issueRef: p.issueRef,
      repos: [project.id],
      instruction: task,
      title: task.split('\n')[0]!.slice(0, 80),
      branch: null,
      worktreePath: null,
      sessionId: null,
      status: 'idle',
      error: null,
      depth: p.depth + 1,
      maxDepth: p.maxDepth,
      // sub-agente no mesmo repositório entrega pelo branch; o pai abre o MR
      openMr: role === 'sub' ? false : p.openMr,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      plan: null,
      mrRef: null,
      createdAt: nowIso(),
    };
    const pn = this.d.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'agent'), eq(node.refId, parentId), isNull(node.removedAt)))
      .get();
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'agent' as const,
      refId: id,
      x: (pn?.x ?? 0) + (siblings % 3) * 436 - (siblings >= 3 ? 0 : 0),
      y: (pn?.y ?? 0) + 420 + Math.floor(siblings / 3) * 400,
      createdAt: nowIso(),
    };
    const e = {
      id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      fromNodeId: pn?.id ?? '',
      toNodeId: n.id,
      kind: 'spawn' as const,
    };
    this.d.db.transaction((tx) => {
      tx.insert(agentT).values(row).run();
      tx.insert(node).values(n).run();
      if (pn) tx.insert(edge).values(e).run();
    });
    this.d.hub.broadcast([
      { type: 'agent.upsert', agent: toAgent(row) },
      { type: 'node.upsert', node: n },
      ...(pn ? [{ type: 'edge.upsert' as const, edge: e }] : []),
      this.d.store.logActivity(`${p.name} criou ${row.name} para ${project.name}`),
    ]);
    // contexto do filho: o plano do pai e o que o pai passou
    this.d.context.seed(id, [
      ...(p.plan?.length ? [{ kind: 'plan' as const, ref: parentId }] : []),
      ...(input.context ?? []),
    ]);
    // liga o passo do plano que cita o repositório ao filho
    if (p.plan) {
      const idx = p.plan.findIndex(
        (it) => !it.agentId && !it.done && it.text.toLowerCase().includes(project.name.toLowerCase()),
      );
      if (idx >= 0)
        this.savePlan(
          parentId,
          p.plan.map((it, k) => (k === idx ? { ...it, agentId: id } : it)),
        );
    }
    this.event(parentId, { kind: 'spawn', childId: id, childName: row.name, repo: project.name, task });
    this.event(id, { kind: 'user_message', text: task });
    void this.launch(id, task, false).catch(() => {});
    return toAgent(row);
  }

  /**
   * Agente fix ou reviewer de um MR aberto por outro agente (automações e caixa de Ações).
   * Fica abaixo do autor na árvore, sem poder criar sub-agentes. O fix trabalha no worktree e
   * no branch do autor, para os commits irem ao mesmo MR; o reviewer ganha um worktree só dele.
   */
  helper(role: 'fix' | 'reviewer', mr: MergeRequest, task: string): Agent {
    const author = mr.agentId ? this.get(mr.agentId) : null;
    if (!author) throw new AgentError('O MR não foi aberto por um agente do canvas.');
    if (role === 'fix' && (!author.worktreePath || !author.branch))
      throw new AgentError(`${author.name} não tem mais o worktree do MR.`);
    const count =
      this.d.db
        .select({ n: sql<number>`count(*)` })
        .from(agentT)
        .get()?.n ?? 0;
    const id = `a_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const row: Row = {
      id,
      name: `agente-${count + 1}`,
      role,
      parentId: author.id,
      issueRef: mr.issueRef ?? author.issueRef,
      repos: [mr.projectId],
      instruction: task,
      title: role === 'fix' ? `Corrigir o pipeline do !${mr.iid}` : `Revisar o !${mr.iid}`,
      branch: role === 'fix' ? author.branch : null,
      worktreePath: role === 'fix' ? author.worktreePath : null,
      sessionId: null,
      status: 'idle',
      error: null,
      depth: author.depth + 1,
      maxDepth: author.depth + 1,
      openMr: false,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      plan: null,
      mrRef: mr.ref,
      createdAt: nowIso(),
    };
    // ao lado do nó do MR, com a aresta MR → agente
    const mn = this.d.db
      .select()
      .from(node)
      .where(and(eq(node.type, 'mr'), eq(node.refId, mr.ref), isNull(node.removedAt)))
      .get();
    const helpers = this.agents().filter((x) => x.mrRef === mr.ref).length;
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'agent' as const,
      refId: id,
      x: (mn?.x ?? 0) + 380,
      y: (mn?.y ?? 0) - 40 + helpers * 420,
      createdAt: nowIso(),
    };
    const e = {
      id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      fromNodeId: mn?.id ?? '',
      toNodeId: n.id,
      kind: 'spawn' as const,
    };
    this.d.db.transaction((tx) => {
      tx.insert(agentT).values(row).run();
      tx.insert(node).values(n).run();
      if (mn) tx.insert(edge).values(e).run();
    });
    this.d.hub.broadcast([
      { type: 'agent.upsert', agent: toAgent(row) },
      { type: 'node.upsert', node: n },
      ...(mn ? [{ type: 'edge.upsert' as const, edge: e }] : []),
      this.d.store.logActivity(
        role === 'fix'
          ? `${row.name} criado para corrigir o pipeline do MR !${mr.iid}`
          : `${row.name} criado para revisar o MR !${mr.iid}`,
      ),
    ]);
    this.d.context.seed(id, [{ kind: role === 'fix' ? 'pipeline_log' : 'mr_diff', ref: mr.ref }]);
    this.event(id, { kind: 'user_message', text: task });
    void this.launch(id, task, false).catch(() => {});
    return toAgent(row);
  }

  /** A pasta de trabalho do agente foi apagada (limpeza): ele não retoma mais aquela sessão. */
  forgetWorktree(agentId: string, note: string): void {
    const a = this.get(agentId);
    if (!a) return;
    this.save(agentId, { worktreePath: null, error: note });
    if (!['done', 'stopped', 'error', 'idle'].includes(a.status)) this.setStatus(agentId, 'stopped', note);
  }

  /**
   * O agente está trabalhando: processo com turno pela frente (o que já deu o result e só está
   * saindo não conta, a não ser que tenha mensagem para retomar) ou na fila.
   */
  busy(agentId: string): boolean {
    const l = this.live.get(agentId);
    if (l && !l.stopping && (!l.inputClosed || l.afterExit)) return true;
    return this.queue.some((q) => q.agentId === agentId);
  }

  /**
   * wait_for_agents: espera os filhos (todos ou os pedidos) pararem de trabalhar e devolve um
   * resumo de cada um. Enquanto isso o chamador fica "coordenando" e não conta no limite.
   */
  async waitFor(callerId: string, ids?: string[]): Promise<string> {
    const caller = this.mustGet(callerId);
    const children = this.agents().filter((a) => a.parentId === callerId);
    const targets = ids?.length
      ? children.filter((c) => ids.includes(c.id) || ids.includes(c.name))
      : children;
    if (!targets.length) return 'Você não tem agentes filhos para esperar.';
    const names = targets.map((t) => t.name);
    const settled = () => targets.every((t) => SETTLED.includes(this.get(t.id)!.status));
    if (!settled()) {
      this.event(callerId, { kind: 'wait', state: 'start', names });
      if (caller.status !== 'waiting') this.setStatus(callerId, 'coordinating');
      this.drainQueue();
      const reason = await new Promise<string | null>((resolve) => {
        this.waiters.push({
          callerId,
          ids: targets.map((t) => t.id),
          done: resolve,
        });
      });
      if (reason) return reason;
      this.event(callerId, { kind: 'wait', state: 'end', names });
      if (this.live.has(callerId)) this.setStatus(callerId, 'running');
    }
    return (await Promise.all(targets.map((t) => this.childSummary(t.id)))).join('\n\n');
  }

  /** Estado, branch, MR, resposta final e o diff do filho (para o pai conferir a consistência). */
  private async childSummary(id: string): Promise<string> {
    const a = this.mustGet(id);
    const project = this.d.settings.projects().find((x) => x.id === a.repos[0]);
    const last = this.events(id, undefined, 400).find((e) => e.body.kind === 'result');
    const result = last?.body.kind === 'result' ? (last.body.text ?? '') : '';
    const mr = this.d.mrOfAgent?.(id);
    return [
      `## ${a.name} (${project?.name ?? 'sem repositório'}): ${a.status}`,
      a.branch ? `Branch: ${a.branch}` : null,
      mr ? `MR !${mr.iid} (${mr.state}, pipeline: ${mr.pipelineStatus}): ${mr.webUrl}` : null,
      a.error ? `Erro: ${a.error}` : null,
      result ? `Resposta final:\n${result.slice(0, 2000)}` : null,
      await this.childDiff(a),
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Diff do branch do filho em relação à base, cortado: o pai não lê os worktrees dos filhos. */
  private async childDiff(a: Agent): Promise<string | null> {
    if (!a.worktreePath || !a.branch || a.repos[0] === undefined) return null;
    const r = this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, a.repos[0])).get();
    const parent = a.parentId ? this.get(a.parentId) : null;
    const base = a.role === 'sub' && parent?.branch ? parent.branch : (r?.defaultBranch ?? 'main');
    const files = await localDiff(a.worktreePath, base).catch(() => []);
    if (!files.length) return 'Diff: (nenhuma mudança commitada)';
    const MAX = 6000;
    let text = files.map((f) => `--- ${f.newPath}\n${f.diff}`).join('\n');
    if (text.length > MAX)
      text = `${text.slice(0, MAX)}\n… (diff cortado; ${files.length} arquivos no total)`;
    return `Diff (${files.map((f) => f.newPath).join(', ')}):\n\`\`\`diff\n${text}\n\`\`\``;
  }

  /** Confere as esperas depois de qualquer mudança de status. */
  private checkWaiters(): void {
    for (const w of [...this.waiters]) {
      if (w.ids.every((id) => SETTLED.includes(this.get(id)?.status ?? 'done'))) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.done(null);
      }
    }
  }

  private cancelWait(callerId: string, why: string): void {
    for (const w of this.waiters.filter((x) => x.callerId === callerId)) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.done(why);
    }
  }

  /** report_plan: publica o plano em checklist (terminal e painel). */
  reportPlan(agentId: string, items: PlanItem[]): void {
    const a = this.mustGet(agentId);
    const old = a.plan ?? [];
    const kids = this.agents().filter((x) => x.parentId === agentId);
    const projects = this.d.settings.projects();
    const used = new Set<string>();
    // mantém o vínculo passo → filho: pelo texto igual ou, se o texto mudou, pelo repositório citado
    const plan = items.map((it) => {
      const byText = it.agentId ?? old.find((o) => o.text === it.text)?.agentId ?? null;
      const byRepo = kids.find((k) => {
        const name = projects.find((p) => p.id === k.repos[0])?.name.toLowerCase();
        return !used.has(k.id) && !!name && it.text.toLowerCase().includes(name);
      })?.id;
      const id = byText ?? byRepo ?? null;
      if (id) used.add(id);
      return { text: it.text, done: it.done, agentId: id };
    });
    this.savePlan(agentId, plan, true);
    this.event(agentId, { kind: 'plan', items: plan });
  }

  /**
   * Grava o plano. Só um report_plan do pai avisa os filhos (o plano está no contexto deles);
   * ligar um passo a um filho ou marcar como feito não interrompe ninguém.
   */
  private savePlan(agentId: string, plan: PlanItem[], notifyChildren = false): void {
    this.save(agentId, { plan });
    if (notifyChildren)
      for (const c of this.agents().filter((x) => x.parentId === agentId)) this.onPlanChanged?.(c.id);
  }

  /** O serviço de contexto avisa os filhos que o plano do pai mudou. */
  onPlanChanged: ((childId: string) => void) | null = null;

  /** ask_human: pergunta ao usuário pela aba Ações e espera a resposta. */
  async ask(agentId: string, text: string, options: string[]): Promise<string> {
    this.mustGet(agentId);
    const answer = await this.d.questions.ask(agentId, text, options);
    return answer ?? 'A pergunta foi cancelada (o agente foi pausado ou parado).';
  }

  private onQuestion(q: Question): void {
    if (this.closed) return;
    const a = this.get(q.agentId);
    if (!a) return;
    this.event(q.agentId, { kind: 'question', questionId: q.id, text: q.text, answer: q.answer });
    if (q.status === 'pending') {
      this.setStatus(q.agentId, 'waiting');
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} perguntou: ${q.text.slice(0, 80)}`));
    } else if (
      a.status === 'waiting' &&
      !this.d.approvals.hasPending(q.agentId) &&
      !this.d.questions.hasPending(q.agentId) &&
      this.live.has(q.agentId)
    ) {
      this.setStatus(q.agentId, 'running');
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
    if (status === 'done' && a.parentId) {
      // passo do plano do pai ligado a este filho
      const p = this.get(a.parentId);
      if (p?.plan?.some((it) => it.agentId === id && !it.done))
        this.savePlan(
          p.id,
          p.plan.map((it) => (it.agentId === id ? { ...it, done: true } : it)),
        );
    }
    if (a.status !== status) {
      this.checkWaiters();
      if (status === 'coordinating') this.drainQueue();
    }
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
