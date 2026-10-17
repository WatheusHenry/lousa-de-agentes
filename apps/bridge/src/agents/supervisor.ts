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
  isLocalProject,
  AGENT_NAME_MAX,
  conciseName,
  uniqueName,
} from '@agent-canvas/shared';
import type { ApprovalService } from '../approvals/approval-service.ts';
import { DISALLOWED_TOOLS } from '../approvals/rules.ts';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import { writeContext } from '../context/builder.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, agentEvent, edge, node, repo as repoT } from '../db/schema.ts';
import { turnErrorMessage } from './turn-error.ts';
import { createWorktree, localDiff, slugify } from '../git/worktree.ts';
import type { Hub } from '../hub.ts';
import { APPROVE_TOOL, CANVAS_TOOLS, MCP_SERVER_NAME, type McpAgentContext } from '../mcp/canvas-server.ts';
import type { SettingsService } from '../settings.ts';
import type { QuestionService } from './questions.ts';
import type { AgentProcess, AgentRunner } from './runner.ts';
import { parseLine } from './stream-parser.ts';

export class AgentError extends Error {}

const rolePrompt = (name: string) => readFileSync(new URL(`./roles/${name}.md`, import.meta.url), 'utf8');
/** Como e quando dividir o trabalho: vai junto dos papéis que podem criar filhos. */
const DELEGATION = rolePrompt('delegation');
/** Prompt de sistema de cada papel. */
const ROLE_PROMPTS: Record<AgentRole, string> = {
  main: `${rolePrompt('main')}\n${DELEGATION}`,
  orchestrator: `${rolePrompt('orchestrator')}\n${DELEGATION}`,
  sub: `${rolePrompt('sub')}\n${DELEGATION}`,
  explorer: rolePrompt('explorer'),
  reviewer: rolePrompt('reviewer'),
  fix: rolePrompt('fix'),
};
/** Estados em que um filho já não está trabalhando (wait_for_agents devolve). */
const SETTLED: AgentStatus[] = ['done', 'error', 'stopped', 'paused', 'idle'];
/** O explorador só lê: sem edição de arquivos (comandos ainda passam pelas permissões). */
const EXPLORER_DISALLOWED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
/** Tipo de filho pedido no spawn_agent: implementar (worktree próprio) ou só investigar. */
export type SpawnKind = 'code' | 'explore';
export interface SpawnInput {
  /** Projeto do filho; vazio = o mesmo do pai. */
  repo?: string;
  task: string;
  kind?: SpawnKind;
  /** Modelo do filho (`opus`, `sonnet`, `haiku`…); vazio = o do pai. */
  model?: string;
  context?: { kind: ContextKind; ref: string }[];
}
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
  /** Tempo máximo de um turno (limite do supervisor). */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Turno terminado e processo aberto esperando a próxima mensagem (como o CLI): a mensagem
   * seguinte entra direto, sem reabrir o claude. Fecha sozinho depois de um tempo parado.
   */
  idle: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Já veio o init deste processo: os seguintes (um por turno) não viram linha nova. */
  inited: boolean;
}

/** Quanto um processo ocioso fica aberto esperando a próxima mensagem. */
export const IDLE_MS = 10 * 60_000;

/** Limites globais do supervisor (seção 8 do plano). */
export interface SupervisorLimits {
  /** Agentes rodando ao mesmo tempo; o resto fica na fila. Coordenando não conta. */
  maxRunning: number;
  /** Filhos trabalhando ao mesmo tempo para um mesmo agente. */
  maxChildren: number;
  /** Tempo máximo de um processo de agente, em minutos; depois disso ele é pausado. */
  maxAgentMinutes: number;
  /** Tokens (entrada + saída) somados de uma árvore de agentes. */
  treeTokenBudget: number;
}

export const DEFAULT_LIMITS: SupervisorLimits = {
  maxRunning: 4,
  maxChildren: 4,
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
  /** Monta o context.md com os itens de contexto do agente. */
  context: {
    render(agentId: string): Promise<string>;
    /** Itens que o sub-agente recebe ao nascer (plano do pai e o que o pai passou). */
    seed(agentId: string, items: { kind: ContextKind; ref: string }[]): void;
  };
  questions: QuestionService;
  /** MR do agente, para o resumo do wait_for_agents. */
  mrOfAgent?: (agentId: string) => MergeRequest | null;
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
  /** Último context.md entregue a cada agente (para mandar só o que mudou depois). */
  private sentContext = new Map<string, string>();
  /** Texto ao vivo (streaming) acumulado por agente, enviado ao canvas em lotes. */
  private deltas = new Map<string, string>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tempo que um processo ocioso fica aberto (os testes encurtam). */
  idleMs = IDLE_MS;
  private queue: Queued[] = [];
  /** wait_for_agents em andamento: quem espera, quando está pronto e como responder. */
  private waiters: { callerId: string; ready: () => boolean; done: (cancelled: string | null) => void }[] =
    [];
  /**
   * Filhos cujo resultado o pai ainda não recebeu (por wait_for_agents). Se o pai terminar o
   * turno sem esperar, ele é acordado com o resumo quando todos esses filhos pararem.
   */
  private unreported = new Map<string, Set<string>>();
  private closed = false;
  /** Agentes começando (worktree e contexto sendo preparados): já ocupam vaga no limite. */
  private starting = new Set<string>();
  /** Agentes que trabalhavam quando o bridge parou (crash ou desligamento): `recover()` decide. */
  private interrupted: string[] = [];

  constructor(private readonly d: SupervisorDeps) {
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
  recentEvents(agents = this.agents()): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const a of agents) out.push(...this.events(a.id, undefined, EVENTS_PER_AGENT).reverse());
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
      case 'agent.rename':
        return void this.rename(msg.agentId, msg.name);
      case 'agent.mode':
        return void this.setAutoMode(msg.agentId, msg.auto);
      case 'agent.model':
        return void this.setModel(msg.agentId, msg.model);
      case 'agent.message':
        return this.message(msg.agentId, msg.text);
      case 'agent.pause':
        return this.pause(msg.agentId);
      case 'agent.resume':
        return this.resume(msg.agentId);
      case 'agent.stop':
        // parar um agente para também os filhos que ele criou
        return this.stopTree(msg.agentId, 'Parado por você.');
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
      name: this.autoName(issue ? { iid: issue.iid, text: issue.title } : { text: instruction }, count + 1),
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
      autoMode: this.d.settings.agentSettings().autoMode,
      model: msg.model ?? null,
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
      // agente de uma issue fica no workspace dela; os outros, no aberto
      workspaceId:
        (msg.issueRef && this.d.store.refWorkspace('issue', msg.issueRef)) || this.d.store.workspace(),
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

  /** Modelo do turno: o escolhido no agente, senão o das configurações, senão o do Claude Code. */
  private modelOf(a: Agent): { model?: string } {
    const model = a.model ?? this.d.settings.agentSettings().model;
    return model ? { model } : {};
  }

  /** Liga/desliga o modo automático; ao ligar, libera o que o agente estava esperando. */
  setAutoMode(agentId: string, on: boolean): Agent {
    this.mustGet(agentId);
    const a = this.save(agentId, { autoMode: on });
    if (on) this.d.approvals.releaseAuto(agentId);
    this.d.hub.broadcast(
      this.d.store.logActivity(
        `${a.name} ${on ? 'no modo automático' : 'voltou a pedir permissão'}`,
        this.d.store.agentWorkspace(a.id),
      ),
    );
    return a;
  }

  /** Troca o modelo do agente; o processo em curso segue no atual, o próximo turno usa o novo. */
  setModel(agentId: string, model: string | null): Agent {
    const before = this.mustGet(agentId);
    if (before.model === model) return before;
    const a = this.save(agentId, { model });
    const shown = model ?? `padrão (${this.d.settings.agentSettings().model ?? 'do Claude Code'})`;
    this.d.hub.broadcast(
      this.d.store.logActivity(
        `${a.name} usa o modelo ${shown}${this.live.has(agentId) ? ' a partir do próximo turno' : ''}`,
        this.d.store.agentWorkspace(a.id),
      ),
    );
    return a;
  }

  /** Nome curto e único: "#142 moeda checkout"; sem texto útil, `agente-N`. */
  private autoName(src: { iid?: number; text?: string | null }, n: number, selfId?: string): string {
    const short = conciseName(src.text ?? '');
    const base = src.iid ? `#${src.iid}${short ? ` ${short}` : ''}` : short || `agente-${n}`;
    return uniqueName(
      base.slice(0, AGENT_NAME_MAX),
      this.agents()
        .filter((x) => x.id !== selfId)
        .map((x) => x.name),
    );
  }

  rename(agentId: string, raw: string): Agent {
    const a = this.mustGet(agentId);
    const typed = raw.trim().replace(/\s+/g, ' ');
    const clash = this.agents().find((x) => x.id !== agentId && x.name.toLowerCase() === typed.toLowerCase());
    if (clash) throw new AgentError(`Já existe um agente chamado "${typed}".`);
    const issue = a.issueRef ? this.d.store.cachedIssue(a.issueRef) : null;
    const name =
      typed ||
      this.autoName(
        issue ? { iid: issue.iid, text: issue.title } : { text: a.instruction ?? a.title },
        0,
        agentId,
      );
    if (name === a.name) return a;
    const saved = this.save(agentId, { name });
    this.d.hub.broadcast(this.d.store.logActivity(`${a.name} agora se chama ${name}`));
    return saved;
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

  /**
   * Mensagem ao agente. `from` é o agente pai (message_agent); `shown` é o que vai para a
   * linha do terminal quando o texto entregue é longo demais (o resumo dos filhos).
   */
  async message(agentId: string, text: string, opts: { from?: string; shown?: string } = {}): Promise<void> {
    const a = this.mustGet(agentId);
    const l = this.live.get(agentId);
    this.event(agentId, {
      kind: 'user_message',
      text: opts.shown ?? text,
      ...(opts.from ? { from: opts.from } : {}),
    });
    if (l && !l.stopping && l.inputClosed) {
      // o processo está terminando: a mensagem vai na retomada, assim que ele sair
      l.afterExit = l.afterExit ? `${l.afterExit}\n\n${text}` : text;
      return;
    }
    if (l && !l.stopping && l.idle) return this.wake(agentId, l, text);
    if (l && !l.stopping) {
      l.pausing = false;
      l.turnOpen = true;
      l.proc.send(text);
      if (a.status !== 'waiting') this.setStatus(agentId, 'running');
      return;
    }
    if (!a.sessionId) {
      // agente em branco: a primeira mensagem é a instrução
      this.save(agentId, {
        instruction: text,
        ...(a.issueRef ? {} : { title: text.slice(0, 80) }),
        ...(!a.issueRef && /^agente-\d+$/.test(a.name) ? { name: this.autoName({ text }, 0, agentId) } : {}),
      });
      return this.launch(agentId, a.issueRef ? instructionForIssue(text) : text, false);
    }
    return this.launch(agentId, text, true);
  }

  pause(agentId: string): void {
    const l = this.live.get(agentId);
    if (!l) return;
    // ocioso: não há turno para pausar; só fecha o processo
    if (l.idle) return this.closeIdle(agentId);
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
    if (l?.idle) {
      // processo ocioso: fecha sem mudar o status (o turno já tinha terminado)
      this.closeIdle(agentId);
      return;
    }
    if (l) {
      l.stopping = true;
      l.proc.kill();
    }
    if (!['done', 'stopped', 'error', 'idle'].includes(a.status) || l || a.status === 'queued') {
      this.setStatus(agentId, 'stopped', reason);
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} parado`, this.d.store.agentWorkspace(a.id)));
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
      if (l.idleTimer) clearTimeout(l.idleTimer);
      l.proc.kill();
    }
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
  }

  // ---------- execução ----------

  /** Limites em uso: ajustados na tela (configurações dos agentes) ou os padrões. */
  private get limits(): SupervisorLimits {
    const a = this.d.settings.agentSettings();
    return {
      maxRunning: a.maxRunning,
      maxChildren: a.maxChildren,
      maxAgentMinutes: a.maxAgentMinutes,
      treeTokenBudget: a.treeTokenBudget,
    };
  }

  /** Processos rodando que contam no limite (coordenando, esperando os filhos, não conta). */
  private runningCount(): number {
    let n = 0;
    for (const [id, l] of this.live) if (!l.idle && this.get(id)?.status !== 'coordinating') n++;
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
          `A árvore deste agente passou do orçamento de ${Math.round(this.limits.treeTokenBudget / 1000)}k tokens. Aumente em Automações → Agentes para continuar.`,
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
          a.role === 'orchestrator' || a.role === 'explorer'
            ? 'preparando o espaço de trabalho'
            : 'preparando o worktree',
        );
        if (a.role === 'explorer') {
          // o explorador só lê: pasta própria e leitura do worktree do pai (ou do clone)
          const ws = join(this.d.home, 'workspaces', agentId);
          mkdirSync(ws, { recursive: true });
          a = this.save(agentId, { worktreePath: ws });
          this.d.hub.broadcast(this.d.store.logActivity(`${a.name} investigando ${r.name}`));
        } else if (a.role === 'orchestrator') {
          // o orquestrador não escreve código: pasta própria e leitura dos clones (--add-dir)
          const ws = join(this.d.home, 'workspaces', agentId);
          mkdirSync(ws, { recursive: true });
          a = this.save(agentId, { worktreePath: ws });
          this.d.hub.broadcast(
            this.d.store.logActivity(
              `${a.name} coordenando ${repos.map((x) => x.name).join(', ')}`,
              this.d.store.agentWorkspace(a.id),
            ),
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
            // repositório local: parte do branch local, não do origin (que pode estar atrás)
            ...(localBase || r.local ? { localBase: true } : {}),
          });
          a = this.save(agentId, { worktreePath: wt.path, branch: wt.branch });
          this.d.hub.broadcast(
            this.d.store.logActivity(
              `${a.name} trabalhando em ${r.name} · ${wt.branch}`,
              this.d.store.agentWorkspace(a.id),
            ),
          );
        }
      }

      const content = await this.refreshContext(a);
      const sessionId = a.sessionId ?? randomUUID();
      const started = resume && this.hasInit(agentId);
      const notices = this.contextNotices.get(agentId);
      this.contextNotices.delete(agentId);
      if (!started) {
        // o contexto vai na própria mensagem: o agente não gasta um turno lendo o arquivo
        text = withContext(text, content);
        this.sentContext.set(agentId, content);
      } else if (notices?.length) {
        text = `${text}\n\n${this.contextUpdate(agentId, notices, content)}`;
      }
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
          disallowedTools:
            a.role === 'explorer' ? [...DISALLOWED_TOOLS, ...EXPLORER_DISALLOWED] : DISALLOWED_TOOLS,
          ...(a.role === 'orchestrator' ? { addDirs: repos.map((x) => x.localPath) } : {}),
          ...(a.role === 'explorer' ? { addDirs: [this.explorerDir(a, r.localPath)] } : {}),
          ...this.modelOf(a),
        },
        {
          onLine: (line) => this.onLine(agentId, line),
          onExit: (info) => this.onExit(agentId, info),
        },
      );
      this.live.set(agentId, {
        proc,
        turnOpen: true,
        pausing: false,
        stopping: false,
        inputClosed: false,
        afterExit: null,
        timer: null,
        idle: false,
        idleTimer: null,
        inited: false,
      });
      this.armTurnTimer(agentId);
      this.starting.delete(agentId);
      this.save(agentId, { error: null });
      this.setStatus(agentId, 'running');
      proc.send(text);
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

  /** O que o explorador lê: o worktree do pai no mesmo repositório (com o trabalho dele) ou o clone. */
  private explorerDir(a: Agent, clone: string): string {
    const parent = a.parentId ? this.get(a.parentId) : null;
    return parent?.worktreePath &&
      parent.role !== 'orchestrator' &&
      parent.repos[0] === a.repos[0] &&
      existsSync(parent.worktreePath)
      ? parent.worktreePath
      : clone;
  }

  /** Regrava o context.md com os itens de contexto do agente (seção 7 do plano). */
  private async refreshContext(a: Agent): Promise<string> {
    const content = await this.d.context.render(a.id);
    writeContext(a.worktreePath!, content);
    return content;
  }

  /** Aviso de contexto novo, com só as seções que mudaram desde a última entrega. */
  private contextUpdate(agentId: string, labels: string[], content: string): string {
    const prev = this.sentContext.get(agentId);
    this.sentContext.set(agentId, content);
    const delta = prev !== undefined ? contextDelta(prev, content) : null;
    return delta
      ? `O contexto foi atualizado (${labels.join('; ')}). O que mudou:\n\n<contexto-atualizado>\n${delta}\n</contexto-atualizado>`
      : `O contexto foi atualizado: ${labels.join('; ')}. A versão completa está em .agent-canvas/context.md; leia se precisar.`;
  }

  /** Tempo máximo de um turno: conta só enquanto o agente trabalha, não parado esperando. */
  private armTurnTimer(agentId: string): void {
    const l = this.live.get(agentId);
    if (!l) return;
    if (l.timer) clearTimeout(l.timer);
    l.timer = setTimeout(() => {
      const cur = this.get(agentId);
      if (!this.live.has(agentId) || cur?.status === 'coordinating' || this.live.get(agentId)?.idle) return;
      this.event(agentId, {
        kind: 'error',
        message: `Passou do tempo máximo de ${this.limits.maxAgentMinutes} min (Automações → Agentes). Pausado; retome para continuar.`,
      });
      this.pause(agentId);
    }, this.limits.maxAgentMinutes * 60_000);
    l.timer.unref?.();
  }

  /** Mensagem para um agente ocioso: entra no mesmo processo, sem reabrir o claude. */
  private async wake(agentId: string, l: Live, text: string): Promise<void> {
    const a = this.mustGet(agentId);
    // os mesmos limites de quando o processo abre: orçamento da árvore
    if (this.treeTokens(agentId) > this.limits.treeTokenBudget) {
      const message = `A árvore deste agente passou do orçamento de ${Math.round(this.limits.treeTokenBudget / 1000)}k tokens. Aumente em Automações → Agentes para continuar.`;
      this.closeIdle(agentId);
      this.event(agentId, { kind: 'error', message });
      this.save(agentId, { error: message });
      this.setStatus(agentId, 'error');
      throw new AgentError(message);
    }
    // outro agente trabalhando no mesmo worktree (o fix no MR deste): espera ele terminar
    const sharing = a.worktreePath
      ? [...this.live.keys()].find(
          (id) => id !== agentId && this.busy(id) && this.get(id)?.worktreePath === a.worktreePath,
        )
      : undefined;
    if (sharing)
      throw new AgentError(
        `${this.get(sharing)!.name} está trabalhando no mesmo worktree. Espere ele terminar.`,
      );
    // sem vaga: fecha o processo e entra na fila, como uma retomada
    if (this.runningCount() >= this.limits.maxRunning) {
      this.closeIdle(agentId);
      this.queue.push({ agentId, text, resume: true });
      this.setStatus(agentId, 'queued', `na fila: ${this.limits.maxRunning} agentes já estão rodando`);
      return;
    }
    l.idle = false;
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = null;
    l.pausing = false;
    l.turnOpen = true;
    const notices = this.contextNotices.get(agentId);
    this.contextNotices.delete(agentId);
    if (notices?.length && a.worktreePath) {
      const content = await this.refreshContext(a);
      text = `${text}\n\n${this.contextUpdate(agentId, notices, content)}`;
    }
    this.armTurnTimer(agentId);
    this.save(agentId, { error: null });
    this.setStatus(agentId, 'running');
    l.proc.send(text);
  }

  /** Fecha o processo ocioso (a próxima mensagem retoma a sessão com --resume). */
  private closeIdle(agentId: string): void {
    const l = this.live.get(agentId);
    if (!l?.idle) return;
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = null;
    closeInput(l);
  }

  /** Muitos ociosos abertos ao mesmo tempo gastam memória: fecha os mais antigos. */
  private trimIdle(): void {
    const idle = [...this.live].filter(([, l]) => l.idle && !l.inputClosed).map(([id]) => id);
    for (const id of idle.slice(0, Math.max(0, idle.length - this.limits.maxRunning))) this.closeIdle(id);
  }

  /** Texto ao vivo do streaming: junta os pedaços e manda ao canvas a cada ~50 ms. */
  private pushDelta(agentId: string, text: string): void {
    this.deltas.set(agentId, (this.deltas.get(agentId) ?? '') + text);
    this.deltaTimer ??= setTimeout(() => {
      this.deltaTimer = null;
      const batch = [...this.deltas];
      this.deltas.clear();
      for (const [id, t] of batch) this.d.hub.broadcast({ type: 'agent.delta', agentId: id, text: t });
    }, 50);
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
    const l = this.live.get(agentId);
    let notified = false;
    // ocioso: não acorda o agente (gastaria um turno); o aviso vai com a próxima mensagem
    if (l && !l.stopping && !l.pausing && !l.idle) {
      const notice = this.contextUpdate(agentId, labels, readFileSync(file, 'utf8'));
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
    if (p.ephemeral) {
      if (p.delta) this.pushDelta(agentId, p.delta);
      return;
    }
    // a mensagem completa (ou o fim do turno) chegou: os pedaços ao vivo pendentes ficam velhos
    if (p.events.length || p.turn) this.deltas.delete(agentId);
    const live = this.live.get(agentId);
    if (p.events[0]?.kind === 'init') {
      // processo aberto entre turnos: só o primeiro init é "início"; o resto não é retomada
      if (live?.inited) p.events = p.events.slice(1);
      else if (live) live.inited = true;
    }
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
      this.d.hub.broadcast(this.d.store.logActivity(`${a.name} pausado`, this.d.store.agentWorkspace(a.id)));
      return;
    }
    if (turn.isError) {
      this.save(agentId, { error: turnErrorMessage(turn.subtype, turn.text) });
      if (l) closeInput(l);
      this.setStatus(agentId, 'error');
      return;
    }
    // o processo fica aberto esperando a próxima mensagem (como o CLI); fecha se ficar parado
    if (l && !l.inputClosed) {
      l.idle = true;
      if (l.timer) clearTimeout(l.timer);
      l.timer = null;
      l.idleTimer = setTimeout(() => this.closeIdle(agentId), this.idleMs);
      l.idleTimer.unref?.();
      this.trimIdle();
    }
    this.setStatus(agentId, 'done');
    queueMicrotask(() => this.drainQueue());
    this.d.hub.broadcast(this.d.store.logActivity(`${a.name} concluiu o turno`));
    // terminou o turno sem esperar os filhos: recebe o resumo quando eles pararem
    queueMicrotask(() => void this.reportToParent(agentId));
  }

  private onExit(
    agentId: string,
    info: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ) {
    if (this.closed) return;
    const l = this.live.get(agentId);
    this.live.delete(agentId);
    if (l?.timer) clearTimeout(l.timer);
    if (l?.idleTimer) clearTimeout(l.idleTimer);
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
        this.d.store.logActivity(
          `${a.name} pediu permissão: ${ap.toolName}(${ap.summary})`,
          this.d.store.agentWorkspace(a.id),
        ),
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

  /** Filhos criados com spawn_agent (os ajudantes de MR, fix e reviewer, ficam de fora). */
  children(parentId: string): Agent[] {
    return this.agents().filter((x) => x.parentId === parentId && !x.mrRef);
  }

  /** Filho direto do agente, pelo nome (agente-3) ou id. */
  private childOf(parentId: string, who: string): Agent {
    const want = who.trim().toLowerCase();
    const c = this.children(parentId).find((x) => x.id === who.trim() || x.name.toLowerCase() === want);
    if (!c)
      throw new AgentError(`"${who}" não é um agente filho seu. Use list_agents para ver os seus filhos.`);
    return c;
  }

  /**
   * spawn_agent: cria um filho com uma tarefa. Recusa além da profundidade escolhida pelo usuário
   * e de quantos filhos podem trabalhar ao mesmo tempo. `code` ganha worktree próprio (num
   * branch a partir do do pai, no mesmo repositório); `explore` só lê e responde. O filho herda a
   * issue, as notas ligadas aos agentes acima dele e o plano do pai, e começa na hora (ou entra
   * na fila).
   */
  async spawn(parentId: string, input: SpawnInput): Promise<Agent> {
    const p = this.mustGet(parentId);
    if (p.depth >= p.maxDepth)
      throw new AgentError(
        p.maxDepth === 0
          ? 'O usuário não liberou sub-agentes para esta tarefa. Faça o trabalho você mesmo.'
          : `Profundidade máxima (${p.maxDepth}) atingida: faça esta parte você mesmo.`,
      );
    if (this.treeTokens(parentId) > this.limits.treeTokenBudget)
      throw new AgentError('A árvore de agentes passou do orçamento de tokens; termine com o que já tem.');
    const active = this.children(parentId).filter((c) => !SETTLED.includes(c.status));
    if (active.length >= this.limits.maxChildren)
      throw new AgentError(
        `Você já tem ${active.length} filhos trabalhando (${active.map((c) => c.name).join(', ')}), o máximo ` +
          `ao mesmo tempo (Automações → Agentes). Espere algum com wait_for_agents (mode "any") antes de criar outro.`,
      );
    const kind: SpawnKind = input.kind ?? 'code';
    const want = input.repo?.trim().toLowerCase() ?? '';
    const projects = this.d.settings.projects();
    const project = want
      ? projects.find(
          (x) =>
            String(x.id) === want ||
            x.name.toLowerCase() === want ||
            x.pathWithNamespace.toLowerCase() === want,
        )
      : p.role === 'orchestrator'
        ? undefined
        : projects.find((x) => x.id === p.repos[0]);
    if (!project)
      throw new AgentError(
        want
          ? `Repositório "${input.repo}" não está entre os escolhidos. Opções: ${projects.map((x) => x.name).join(', ')}.`
          : 'Diga em `repo` em qual repositório o filho trabalha.',
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
    const role: AgentRole =
      kind === 'explore'
        ? 'explorer'
        : p.role === 'orchestrator' || project.id !== p.repos[0]
          ? 'main'
          : 'sub';
    const task = input.task.trim();
    const row: Row = {
      id,
      name: this.autoName({ text: task }, count + 1),
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
      // o explorador não delega: responde ao pai
      maxDepth: role === 'explorer' ? p.depth + 1 : p.maxDepth,
      // sub-agente no mesmo repositório entrega pelo branch; o pai abre o MR
      openMr: role === 'sub' || role === 'explorer' ? false : p.openMr,
      // filhos herdam o modo e o modelo do pai (o pai pode escolher outro modelo para o filho)
      autoMode: p.autoMode,
      model: input.model?.trim() || p.model,
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
    // o filho fica no workspace do pai, mesmo que outro esteja aberto
    const ws = pn?.workspaceId ?? this.d.store.agentWorkspace(parentId);
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'agent' as const,
      refId: id,
      ...this.d.store.freeSpot(
        'agent',
        {
          x: (pn?.x ?? 0) + (siblings % 3) * 436,
          y: (pn?.y ?? 0) + 420 + Math.floor(siblings / 3) * 400,
        },
        ws,
      ),
      createdAt: nowIso(),
      workspaceId: ws,
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
      this.d.store.logActivity(
        `${p.name} criou ${row.name} ${role === 'explorer' ? 'para investigar' : 'para'} ${project.name}`,
      ),
    ]);
    this.expectReport(parentId, id);
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
      name: this.autoName(
        { text: role === 'fix' ? `corrigir pipeline !${mr.iid}` : `revisar !${mr.iid}` },
        count + 1,
      ),
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
      autoMode: this.d.settings.agentSettings().autoMode,
      model: author.model,
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
    const ws = mn?.workspaceId ?? this.d.store.agentWorkspace(author.id);
    const n = {
      id: `n_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'agent' as const,
      refId: id,
      ...this.d.store.freeSpot('agent', { x: (mn?.x ?? 0) + 310, y: (mn?.y ?? 0) - 40 + helpers * 420 }, ws),
      createdAt: nowIso(),
      workspaceId: ws,
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
        ws,
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
    if (l && !l.stopping && !l.idle && (!l.inputClosed || l.afterExit)) return true;
    return this.queue.some((q) => q.agentId === agentId);
  }

  /**
   * wait_for_agents: espera os filhos pararem de trabalhar e devolve um resumo de cada um.
   * `all` espera todos (os pedidos ou todos os filhos); `any` volta assim que o primeiro dos que
   * ainda não foram entregues parar, para o pai juntar o resultado e mandar mais trabalho.
   * Enquanto isso o chamador fica "coordenando" e não conta no limite.
   */
  async waitFor(callerId: string, ids?: string[], mode: 'all' | 'any' = 'all'): Promise<string> {
    const caller = this.mustGet(callerId);
    const children = this.children(callerId);
    const pending = this.unreported.get(callerId) ?? new Set<string>();
    const targets = ids?.length
      ? children.filter((c) => ids.includes(c.id) || ids.includes(c.name))
      : mode === 'any'
        ? children.filter((c) => pending.has(c.id) || !SETTLED.includes(c.status))
        : children;
    if (!targets.length)
      return children.length
        ? 'Nenhum filho trabalhando e nenhum resultado novo: você já recebeu o de todos.'
        : 'Você não tem agentes filhos para esperar.';
    const settledNow = () => targets.filter((t) => SETTLED.includes(this.get(t.id)!.status));
    const ready = () => (mode === 'any' ? settledNow().length > 0 : settledNow().length === targets.length);
    if (!ready()) {
      const names = targets.filter((t) => !SETTLED.includes(this.get(t.id)!.status)).map((t) => t.name);
      this.event(callerId, { kind: 'wait', state: 'start', names });
      if (caller.status !== 'waiting') this.setStatus(callerId, 'coordinating');
      this.drainQueue();
      const reason = await new Promise<string | null>((resolve) => {
        this.waiters.push({ callerId, ready, done: resolve });
      });
      if (reason) return reason;
      this.event(callerId, { kind: 'wait', state: 'end', names });
      const l = this.live.get(callerId);
      if (l && !l.stopping && !l.pausing) this.setStatus(callerId, 'running');
    }
    const done = settledNow();
    for (const t of done) pending.delete(t.id);
    const rest = targets.filter((t) => !done.includes(t));
    const out = await Promise.all(done.map((t) => this.childSummary(t.id)));
    if (rest.length)
      out.push(
        `Ainda trabalhando: ${rest.map((t) => `${t.name} (${this.get(t.id)!.status})`).join(', ')}. ` +
          'Chame wait_for_agents de novo para esperar.',
      );
    return out.join('\n\n');
  }

  /** list_agents: os filhos e o que cada um faz, sem esperar ninguém. */
  listChildren(callerId: string): string {
    const caller = this.mustGet(callerId);
    const kids = this.children(callerId);
    const active = kids.filter((c) => !SETTLED.includes(c.status)).length;
    const projects = this.d.settings.projects();
    const left = caller.maxDepth - caller.depth;
    const head =
      left > 0
        ? `Filhos trabalhando: ${active} de ${this.limits.maxChildren} ao mesmo tempo. Vagas de execução no app: ` +
          `${Math.max(0, this.limits.maxRunning - this.runningCount())} de ${this.limits.maxRunning} (o resto vai para a fila).`
        : 'Você não pode criar sub-agentes nesta tarefa.';
    if (!kids.length) return `${head}\nVocê ainda não criou agentes filhos.`;
    const pending = this.unreported.get(callerId);
    return [
      head,
      ...kids.map((k) => {
        const repo = projects.find((p) => p.id === k.repos[0])?.name ?? 'sem repositório';
        return [
          `- ${k.name} [${k.role === 'explorer' ? 'explore' : 'code'}, ${repo}${k.model ? `, ${k.model}` : ''}]: ${k.status}`,
          k.branch ? `, branch ${k.branch}` : '',
          pending?.has(k.id) && SETTLED.includes(k.status) ? ' (resultado novo: use wait_for_agents)' : '',
          ` · ${k.title}`,
        ].join('');
      }),
    ].join('\n');
  }

  /**
   * message_agent: o pai manda uma mensagem a um filho (correção, pergunta, próxima etapa).
   * Parado, o filho retoma a mesma sessão; trabalhando, a mensagem entra no turno dele.
   */
  async messageChild(callerId: string, who: string, text: string): Promise<Agent> {
    const caller = this.mustGet(callerId);
    const c = this.childOf(callerId, who);
    if (c.status === 'queued' || this.starting.has(c.id))
      throw new AgentError(
        `${c.name} ainda não começou (está na fila). Mande a mensagem depois que ele rodar.`,
      );
    if (!c.sessionId) throw new AgentError(`${c.name} ainda não começou.`);
    if (this.treeTokens(callerId) > this.limits.treeTokenBudget)
      throw new AgentError('A árvore de agentes passou do orçamento de tokens; termine com o que já tem.');
    this.expectReport(callerId, c.id);
    await this.message(c.id, `Mensagem de ${caller.name} (o agente que criou você):\n\n${text}`, {
      from: caller.name,
      shown: text,
    });
    this.d.hub.broadcast(this.d.store.logActivity(`${caller.name} mandou uma mensagem a ${c.name}`));
    return this.mustGet(c.id);
  }

  /** stop_agent: o pai para um filho (e os filhos dele) que não serve mais. */
  stopChild(callerId: string, who: string, reason?: string): Agent {
    const caller = this.mustGet(callerId);
    const c = this.childOf(callerId, who);
    this.unreported.get(callerId)?.delete(c.id);
    this.stopTree(c.id, `Parado por ${caller.name}${reason ? `: ${reason}` : '.'}`);
    return this.mustGet(c.id);
  }

  /** Para o agente e, antes, os filhos que ele criou que ainda trabalham. */
  stopTree(agentId: string, reason: string): void {
    // a espera do pai acaba antes: parar os filhos não deve acordá-lo
    this.cancelWait(agentId, 'A espera foi cancelada: o agente foi parado.');
    for (const c of this.children(agentId)) {
      this.unreported.get(agentId)?.delete(c.id);
      if (this.live.has(c.id) || this.busy(c.id) || !SETTLED.includes(c.status)) this.stopTree(c.id, reason);
    }
    this.stop(agentId, reason);
  }

  /** O pai passa a esperar o resultado deste filho (spawn ou mensagem nova). */
  private expectReport(parentId: string, childId: string): void {
    const set = this.unreported.get(parentId) ?? new Set<string>();
    set.add(childId);
    this.unreported.set(parentId, set);
  }

  /**
   * O pai terminou o turno sem esperar os filhos e todos os que ele não recebeu já pararam:
   * acorda o pai com o resumo, para ele seguir sozinho (juntar branches, conferir, abrir o MR).
   * Não acorda quem foi pausado, parado ou deu erro, nem quem está esperando com wait_for_agents.
   */
  private async reportToParent(parentId: string): Promise<void> {
    const pending = this.unreported.get(parentId);
    if (!pending?.size || this.closed) return;
    const p = this.get(parentId);
    if (!p || p.status !== 'done' || this.busy(parentId) || this.starting.has(parentId)) return;
    if (this.waiters.some((w) => w.callerId === parentId)) return;
    const kids = [...pending].map((id) => this.get(id)).filter((x): x is Agent => !!x);
    if (kids.some((k) => !SETTLED.includes(k.status))) return;
    this.unreported.delete(parentId);
    if (!kids.length) return;
    const names = kids.map((k) => k.name);
    const summaries = await Promise.all(kids.map((k) => this.childSummary(k.id)));
    this.d.hub.broadcast(
      this.d.store.logActivity(`${p.name} recebeu o resultado de ${names.join(', ')} e continua`),
    );
    const text =
      `Os agentes filhos que você criou terminaram (${names.join(', ')}). Resumo de cada um:\n\n` +
      `${summaries.join('\n\n')}\n\nContinue a sua tarefa a partir disso: confira o resultado, junte o que for ` +
      'preciso e siga para o próximo passo (ou corrija/crie filhos, se faltar algo).';
    await this.message(parentId, text, {
      from: 'canvas',
      shown: `Resultado dos filhos: ${names.join(', ')}`,
    }).catch(() => {});
  }

  /** Estado, branch, MR, resposta final e o diff do filho (para o pai conferir a consistência). */
  private async childSummary(id: string): Promise<string> {
    const a = this.mustGet(id);
    const project = this.d.settings.projects().find((x) => x.id === a.repos[0]);
    const last = this.events(id, undefined, 400).find((e) => e.body.kind === 'result');
    const result = last?.body.kind === 'result' ? (last.body.text ?? '') : '';
    const mr = this.d.mrOfAgent?.(id);
    // o explorador entrega só a resposta: mais espaço para ela
    const max = a.role === 'explorer' ? 12_000 : 2000;
    return [
      `## ${a.name} (${a.role === 'explorer' ? 'explore, ' : ''}${project?.name ?? 'sem repositório'}): ${a.status}`,
      a.branch ? `Branch: ${a.branch}` : null,
      mr
        ? isLocalProject(mr.projectId)
          ? `Revisão local #${mr.iid} (${mr.state}), branch ${mr.sourceBranch} → ${mr.targetBranch}`
          : `MR !${mr.iid} (${mr.state}, pipeline: ${mr.pipelineStatus}): ${mr.webUrl}`
        : null,
      a.error ? `Erro: ${a.error}` : null,
      result
        ? `Resposta final:\n${result.length > max ? `${result.slice(0, max)}\n… (cortado)` : result}`
        : null,
      a.role === 'explorer' ? null : await this.childDiff(a),
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
      if (w.ready()) {
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
      this.d.hub.broadcast(
        this.d.store.logActivity(
          `${a.name} perguntou: ${q.text.slice(0, 80)}`,
          this.d.store.agentWorkspace(a.id),
        ),
      );
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
      // um filho parou: o pai que terminou o turno sem esperar pode receber o resumo agora
      const parentId = a.parentId;
      if (parentId && SETTLED.includes(status)) queueMicrotask(() => void this.reportToParent(parentId));
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
  return `Resolva a issue descrita no contexto abaixo. Instruções do usuário: ${extra}`;
}

/** Primeira mensagem: o contexto do canvas vai junto, sem o agente precisar ler o arquivo. */
function withContext(text: string, content: string): string {
  return `${text}\n\n<contexto-do-canvas>\n${content.trim()}\n</contexto-do-canvas>\n\n(Este contexto também fica em .agent-canvas/context.md. Não precisa ler o arquivo agora.)`;
}

/** Limite do aviso de contexto: mais que isso, o agente lê o arquivo se precisar. */
const MAX_CONTEXT_DELTA = 12_000;

/**
 * Seções (títulos "## ") novas ou alteradas entre duas versões do context.md. Nulo quando não
 * dá para resumir (nada mudou nas seções ou o trecho ficaria grande demais).
 */
export function contextDelta(prev: string, next: string): string | null {
  const sections = (s: string) => {
    const m = new Map<string, string>();
    for (const part of s.split(/^(?=## )/m)) m.set(part.split('\n', 1)[0]!.trim(), part.trim());
    return m;
  };
  const before = sections(prev);
  const changed = [...sections(next)].filter(([k, v]) => before.get(k) !== v).map(([, v]) => v);
  const out = changed.join('\n\n');
  return out && out.length <= MAX_CONTEXT_DELTA ? out : null;
}
