import { z } from 'zod';
import { Agent, AgentEvent, Approval, Policy, Question } from './agents.ts';
import { Activity, CanvasEdge, CanvasNode, Note, NoteLink } from './canvas.ts';
import { AgentContext, ContextKind } from './context.ts';
import { Issue, IssueRef, MergeRequest, MrRef } from './gitlab.ts';
import { SettingsView } from './settings.ts';

/** Nome do cabeçalho / parâmetro com o token de sessão do bridge. */
export const SESSION_HEADER = 'x-agent-canvas-token';
export const SESSION_QUERY = 'token';
/** Meta tag em que o index.html recebe o token de sessão. */
export const SESSION_META = 'agent-canvas-token';

/** GET /state: tudo o que o front precisa para desenhar o canvas. */
export const StateSnapshot = z.object({
  settings: SettingsView,
  nodes: z.array(CanvasNode),
  edges: z.array(CanvasEdge),
  notes: z.array(Note),
  noteLinks: z.array(NoteLink),
  /** Issues referenciadas por nós do canvas (do cache local). */
  issues: z.array(Issue),
  activity: z.array(Activity),
  agents: z.array(Agent),
  /** Últimos eventos de cada agente (o histórico completo vem por GET /api/agents/:id/events). */
  agentEvents: z.array(AgentEvent),
  /** Pedidos de permissão pendentes. */
  approvals: z.array(Approval),
  policies: z.array(Policy),
  /** MRs com nó no canvas. */
  mergeRequests: z.array(MergeRequest),
  /** Perguntas pendentes dos agentes (ask_human). */
  questions: z.array(Question),
  /** Issues arquivadas (com agentes, MRs e notas), para restaurar. */
  archived: z.array(
    z.object({
      issueRef: z.string(),
      iid: z.number(),
      title: z.string(),
      projectPath: z.string(),
      archivedAt: z.string(),
      /** Agentes, MRs e notas arquivados junto. */
      items: z.number(),
    }),
  ),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

const Id = z.string().min(1).max(64);
const Coord = z.number().finite();

// ---------- cliente → servidor ----------

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('issue.place'),
    nodeId: Id,
    issueRef: IssueRef,
    x: Coord,
    y: Coord,
  }),
  z.object({ type: z.literal('node.move'), nodeId: Id, x: Coord, y: Coord }),
  /** Tira do canvas a issue com os agentes, MRs e notas dela, sem apagar (restaura depois). */
  z.object({ type: z.literal('issue.archive'), nodeId: Id }),
  z.object({ type: z.literal('issue.unarchive'), issueRef: IssueRef }),
  /** Remoção suave: o nó some, mas pode voltar com node.restore (desfazer). */
  z.object({ type: z.literal('node.remove'), nodeId: Id }),
  z.object({ type: z.literal('node.restore'), nodeId: Id }),
  z.object({
    type: z.literal('note.create'),
    nodeId: Id,
    note: Note.pick({ id: true, title: true, body: true }),
    x: Coord,
    y: Coord,
  }),
  z.object({
    type: z.literal('note.update'),
    noteId: Id,
    title: Note.shape.title.optional(),
    body: Note.shape.body.optional(),
  }),
  z.object({ type: z.literal('note.link'), edgeId: Id, noteId: Id, targetNodeId: Id }),
  z.object({ type: z.literal('note.unlink'), noteId: Id, targetNodeId: Id }),
  /**
   * Cria um agente no canvas. Com `instruction`, começa na hora; sem ela, é um agente em
   * branco que espera contexto e a primeira instrução.
   */
  z.object({
    type: z.literal('agent.create'),
    agentId: Id,
    nodeId: Id,
    edgeId: Id.optional(),
    issueRef: IssueRef.optional(),
    /** Mais de um repositório: o agente é um orquestrador, que cria um agente por repositório. */
    repos: z.array(z.number().int().positive()).max(8),
    instruction: z.string().max(20_000).optional(),
    maxDepth: z.number().int().min(0).max(3).default(1),
    openMr: z.boolean().default(false),
    x: Coord,
    y: Coord,
  }),
  /** Dá contexto a um agente em branco antes de começar: repositório e issue. */
  z.object({
    type: z.literal('agent.update'),
    agentId: Id,
    repos: z.array(z.number().int().positive()).max(1).optional(),
    issueRef: IssueRef.nullable().optional(),
  }),
  z.object({ type: z.literal('agent.message'), agentId: Id, text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal('agent.pause'), agentId: Id }),
  z.object({ type: z.literal('agent.resume'), agentId: Id }),
  z.object({ type: z.literal('agent.stop'), agentId: Id }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: Id,
    decision: z.enum(['allow', 'deny']),
    remember: z.boolean().optional(),
  }),
  z.object({ type: z.literal('policy.remove'), policyId: Id }),
  /** Merge é sempre uma ação humana, pela caixa de Ações. */
  z.object({ type: z.literal('mr.merge'), mrRef: MrRef }),
  z.object({ type: z.literal('mr.refresh'), mrRef: MrRef }),
  /** Cria (ou retoma) o agente fix do MR com pipeline falhando. */
  z.object({ type: z.literal('mr.fix'), mrRef: MrRef }),
  z.object({ type: z.literal('mr.comment'), mrRef: MrRef, body: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal('issue.comment'), issueRef: IssueRef, body: z.string().min(1).max(20_000) }),
  z.object({
    type: z.literal('context.add'),
    agentId: Id,
    kind: ContextKind,
    ref: z.string().min(1).max(512),
  }),
  z.object({ type: z.literal('context.remove'), agentId: Id, itemId: z.string().min(1).max(600) }),
  z.object({ type: z.literal('context.summarize'), agentId: Id, itemId: z.string().min(1).max(600) }),
  z.object({ type: z.literal('context.unsummarize'), agentId: Id, itemId: z.string().min(1).max(600) }),
  z.object({
    type: z.literal('question.answer'),
    questionId: Id,
    answer: z.string().trim().min(1).max(5_000),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- servidor → cliente ----------

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverVersion: z.string() }),
  z.object({ type: z.literal('node.upsert'), node: CanvasNode }),
  z.object({ type: z.literal('node.remove'), nodeId: Id }),
  z.object({ type: z.literal('edge.upsert'), edge: CanvasEdge }),
  z.object({ type: z.literal('edge.remove'), edgeId: Id }),
  z.object({ type: z.literal('note.upsert'), note: Note }),
  z.object({ type: z.literal('noteLink.upsert'), link: NoteLink }),
  z.object({ type: z.literal('noteLink.remove'), link: NoteLink }),
  z.object({ type: z.literal('issue.upsert'), issue: Issue }),
  z.object({ type: z.literal('settings.updated'), settings: SettingsView }),
  z.object({ type: z.literal('activity'), text: z.string(), ts: z.string() }),
  z.object({ type: z.literal('agent.upsert'), agent: Agent }),
  z.object({ type: z.literal('agent.event'), event: AgentEvent }),
  z.object({ type: z.literal('approval.upsert'), approval: Approval }),
  z.object({ type: z.literal('policy.upsert'), policy: Policy }),
  z.object({ type: z.literal('policy.remove'), policyId: z.string() }),
  z.object({ type: z.literal('mr.upsert'), mr: MergeRequest }),
  /** Discussão nova num MR ou numa issue: quem estiver olhando recarrega. */
  z.object({ type: z.literal('thread.changed'), target: z.enum(['mr', 'issue']), ref: z.string() }),
  z.object({ type: z.literal('error'), message: z.string(), cause: z.string().optional() }),
  /**
   * Quando o servidor recarrega o estado (ex.: restaurar um nó traz arestas e notas junto),
   * manda o snapshot inteiro em vez de várias mensagens soltas.
   */
  z.object({ type: z.literal('state.snapshot'), state: StateSnapshot }),
  z.object({ type: z.literal('context.updated'), context: AgentContext }),
  z.object({ type: z.literal('question.upsert'), question: Question }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
