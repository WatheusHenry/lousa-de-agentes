import { z } from 'zod';

export const NodeType = z.enum(['issue', 'agent', 'mr', 'note', 'browser']);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeKind = z.enum(['issue', 'spawn', 'mr', 'note', 'browser']);
export type EdgeKind = z.infer<typeof EdgeKind>;

const Id = z.string().min(1).max(64);

export const CanvasNode = z.object({
  id: Id,
  type: NodeType,
  /** issue: IssueRef; note: id da nota; agent/mr: id do agente/MR; browser: id do navegador. */
  refId: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  createdAt: z.string(),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

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
