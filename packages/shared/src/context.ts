import { z } from 'zod';

/** Tipos de item de contexto (seção 7 do plano). */
export const ContextKind = z.enum(['issue', 'repo', 'note', 'file', 'pipeline_log', 'mr_diff']);
export type ContextKind = z.infer<typeof ContextKind>;

/** Orçamento recomendado de tokens do contexto de um agente. */
export const DEFAULT_CONTEXT_BUDGET = 60_000;
/** A partir daqui o item ganha o botão Resumir. */
export const HEAVY_ITEM_TOKENS = 8_000;

/** Estimativa usada no medidor antes do primeiro turno: ceil(caracteres / 3,5). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export const ContextItem = z.object({
  /** `<kind>:<ref>`, estável. */
  id: z.string(),
  kind: ContextKind,
  /**
   * issue: `<projectId>#<iid>`; repo: id do projeto; note: id da nota; file: caminho relativo
   * ao repositório; pipeline_log e mr_diff: `<projectId>!<iid>`.
   */
  ref: z.string(),
  label: z.string(),
  /** link: vem dos vínculos do canvas (issue, repositório, notas ligadas); added: escolhido à mão. */
  source: z.enum(['link', 'added']),
  /** Tokens do que vai para o context.md (o resumo, se houver). */
  tokens: z.number(),
  /** Tokens do conteúdo completo. */
  fullTokens: z.number(),
  summarized: z.boolean(),
  /** Remover tira o vínculo (nota ligada ao agente) ou exclui só deste agente. */
  removable: z.boolean(),
  /** Resolvedor falhou (ex.: arquivo apagado, GitLab fora do ar). */
  error: z.string().nullable(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const ContextSuggestion = z.object({
  kind: ContextKind,
  ref: z.string(),
  label: z.string(),
  /** Por que foi sugerido, ex.: "citado na issue". */
  why: z.string(),
});
export type ContextSuggestion = z.infer<typeof ContextSuggestion>;

export const AgentContext = z.object({
  agentId: z.string(),
  items: z.array(ContextItem),
  /** Soma dos itens mais o cabeçalho do context.md. */
  totalTokens: z.number(),
  budget: z.number(),
  suggestions: z.array(ContextSuggestion),
  /** Algum item está sendo resumido agora. */
  summarizing: z.array(z.string()),
});
export type AgentContext = z.infer<typeof AgentContext>;
