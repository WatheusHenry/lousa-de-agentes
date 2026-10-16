import { z } from 'zod';
import { AgentStatus } from './canvas.ts';

export const AgentRole = z.enum(['main', 'orchestrator', 'sub', 'reviewer', 'fix']);
export type AgentRole = z.infer<typeof AgentRole>;

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  role: AgentRole,
  parentId: z.string().nullable(),
  /** Issue de origem (`<projectId>#<iid>`), se houver. */
  issueRef: z.string().nullable(),
  /** IDs de projeto do GitLab. Na Fase 2, no máximo um. */
  repos: z.array(z.number()),
  /** Instrução original do usuário; nula num agente em branco que ainda não começou. */
  instruction: z.string().nullable(),
  title: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  sessionId: z.string().nullable(),
  status: AgentStatus,
  /** Mensagem do último erro, quando status = error. */
  error: z.string().nullable(),
  depth: z.number(),
  maxDepth: z.number(),
  openMr: z.boolean(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Tamanho do contexto no último turno (entrada + cache). */
  contextTokens: z.number(),
  costUsd: z.number(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

/** Uma linha do terminal estruturado do agente. */
export const AgentEventBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init'), sessionId: z.string(), model: z.string(), cwd: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('tool_use'),
    toolUseId: z.string(),
    name: z.string(),
    /** Resumo curto para a linha do terminal, ex.: `npm test` ou `src/app.ts`. */
    summary: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean(),
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal('user_message'), text: z.string() }),
  z.object({
    kind: z.literal('permission'),
    approvalId: z.string(),
    toolName: z.string(),
    summary: z.string(),
    status: z.enum(['pending', 'allowed', 'denied']),
  }),
  z.object({ kind: z.literal('status'), status: AgentStatus, note: z.string().optional() }),
  z.object({
    kind: z.literal('result'),
    isError: z.boolean(),
    subtype: z.string(),
    text: z.string().nullable(),
    costUsd: z.number(),
    numTurns: z.number(),
    terminalReason: z.string().nullable(),
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type AgentEventBody = z.infer<typeof AgentEventBody>;

export const AgentEvent = z.object({
  id: z.number(),
  agentId: z.string(),
  ts: z.string(),
  body: AgentEventBody,
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const ApprovalStatus = z.enum(['pending', 'allowed', 'denied']);
export const Approval = z.object({
  id: z.string(),
  agentId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  /** Resumo legível do pedido, ex.: `npm test`. */
  summary: z.string(),
  /** Regra no formato do Claude Code que "Sempre permitir" grava, ex.: `Bash(npm test:*)`. */
  suggestedRule: z.string(),
  status: ApprovalStatus,
  decidedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type Approval = z.infer<typeof Approval>;

export const Policy = z.object({
  id: z.string(),
  pattern: z.string(),
  /** 'global' ou o id do projeto do GitLab, em texto. */
  scope: z.string(),
  createdAt: z.string(),
});
export type Policy = z.infer<typeof Policy>;
