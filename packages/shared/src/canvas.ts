import { z } from 'zod';

export const NodeType = z.enum(['issue', 'agent', 'mr', 'note']);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeKind = z.enum(['issue', 'spawn', 'mr', 'note']);
export type EdgeKind = z.infer<typeof EdgeKind>;

const Id = z.string().min(1).max(64);

export const CanvasNode = z.object({
  id: Id,
  type: NodeType,
  /** issue: IssueRef; note: id da nota; agent/mr: id do agente/MR (fases seguintes). */
  refId: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  /** Tamanho escolhido pelo usuário (redimensionar). Sem valor, o cartão usa o tamanho padrão. */
  w: z.number().finite().optional(),
  h: z.number().finite().optional(),
  createdAt: z.string(),
  /** Workspace do nó (o bridge preenche; o cliente cria sempre no workspace aberto). */
  workspaceId: z.string().optional(),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

/**
 * Limites do redimensionar, em px no zoom 100%. A largura mínima é a padrão de cada cartão; a
 * altura mínima é a do conteúdo (o cartão nunca fica menor que ele), por isso só tem máximo.
 */
export const NODE_SIZE_LIMITS: Record<NodeType, { minW: number; maxW: number; maxH: number }> = {
  issue: { minW: 284, maxW: 560, maxH: 520 },
  mr: { minW: 284, maxW: 560, maxH: 520 },
  note: { minW: 270, maxW: 560, maxH: 640 },
  agent: { minW: 400, maxW: 900, maxH: 900 },
};

export function clampNodeSize(type: NodeType, w: number, h: number): { w: number; h: number } {
  const l = NODE_SIZE_LIMITS[type];
  return {
    w: Math.round(Math.min(l.maxW, Math.max(l.minW, w))),
    h: Math.round(Math.min(l.maxH, Math.max(0, h))),
  };
}

export const CanvasEdge = z.object({
  id: Id,
  fromNodeId: Id,
  toNodeId: Id,
  kind: EdgeKind,
});
export type CanvasEdge = z.infer<typeof CanvasEdge>;

export const Note = z.object({
  id: Id,
  title: z.string().max(300),
  body: z.string().max(200_000),
  isHandoff: z.boolean(),
  /** 'user' ou o id do agente que escreveu. */
  createdBy: z.string(),
});
export type Note = z.infer<typeof Note>;

export const NoteLink = z.object({
  noteId: Id,
  targetNodeId: Id,
});
export type NoteLink = z.infer<typeof NoteLink>;

export const Activity = z.object({ text: z.string(), ts: z.string() });
export type Activity = z.infer<typeof Activity>;

/** Status do agente (usado a partir da Fase 2). */
export const AgentStatus = z.enum([
  'idle',
  /** Esperando vaga: o supervisor limita os agentes rodando ao mesmo tempo. */
  'queued',
  'running',
  'waiting',
  'coordinating',
  'paused',
  'done',
  'stopped',
  'error',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;
