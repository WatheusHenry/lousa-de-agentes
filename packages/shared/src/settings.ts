import { z } from 'zod';
import { GitLabProject, GitLabUser } from './gitlab.ts';

/** `local`: sem GitLab, só com repositórios locais escolhidos pela pasta. */
export const GitLabMode = z.enum(['gitlab', 'demo', 'local']);
export type GitLabMode = z.infer<typeof GitLabMode>;

/** POST /settings/gitlab. O token é opcional para permitir mudar só a URL ou a pasta. */
export const GitLabSettingsInput = z.object({
  mode: GitLabMode.default('gitlab'),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  token: z.string().trim().min(8).max(512).optional(),
  /** Vazio = procurar os clones na pasta pessoal do usuário. */
  reposDir: z.string().trim().max(1024).optional(),
});
export type GitLabSettingsInput = z.input<typeof GitLabSettingsInput>;

/** Resposta de validação do token (GET /user no GitLab). */
export const GitLabValidation = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), user: GitLabUser }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type GitLabValidation = z.infer<typeof GitLabValidation>;

/** Projetos que o usuário escolheu acompanhar no canvas. */
export const ProjectSelectionInput = z.object({
  projectIds: z.array(z.number().int().positive()).max(50),
});
export type ProjectSelectionInput = z.infer<typeof ProjectSelectionInput>;

/** O que o front-end vê das configurações. O token nunca sai do bridge. */
export const SettingsView = z.object({
  mode: GitLabMode,
  baseUrl: z.string(),
  reposDir: z.string(),
  hasToken: z.boolean(),
  /** De onde veio o token: arquivo de segredos do app ou variável de ambiente. */
  tokenSource: z.enum(['secrets-file', 'env']).nullable(),
  user: GitLabUser.nullable(),
  projects: z.array(GitLabProject),
  /** Clone local de cada projeto escolhido; `manual` quando o usuário informou o caminho. */
  clones: z.array(z.object({ projectId: z.number(), path: z.string().nullable(), manual: z.boolean() })),
  configured: z.boolean(),
  automations: z.lazy(() => Automations),
  /** Modelo e limites dos agentes em uso (o que foi mudado na tela, senão o padrão). */
  agents: z.lazy(() => AgentSettings),
  /** Padrões vindos das variáveis de ambiente (ou do app), para o "voltar ao padrão". */
  agentDefaults: z.lazy(() => AgentSettings),
  /** Projetos em modo confiança: o trabalho comum no worktree não pede permissão. */
  trustedRepos: z.array(z.number()),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const RepoPathInput = z.object({ path: z.string().trim().max(1024).nullable() });

/** POST /repos/local: um repositório git escolhido pela pasta, sem precisar do GitLab. */
export const LocalRepoInput = z.object({ path: z.string().trim().min(1).max(1024) });
export type LocalRepoInput = z.infer<typeof LocalRepoInput>;
export type RepoPathInput = z.infer<typeof RepoPathInput>;

/** Interruptores do painel de Automações (seção 9 do plano). */
export const Automations = z.object({
  /** Pipeline de MR de agente falhou → agente fix com o log do job no contexto. */
  fixPipeline: z.boolean(),
  /** Comentário de revisão no MR → vai para a sessão do agente autor. */
  reviewComments: z.boolean(),
  /** MR aberto por agente → agente reviewer comenta no MR. */
  reviewer: z.boolean(),
  /** Agente concluiu → nota de passagem com decisões, arquivos, MRs e pendências. */
  handoff: z.boolean(),
  /** Label agent-ready numa issue → a issue entra no canvas e os agentes começam. */
  agentReady: z.boolean(),
});
export type Automations = z.infer<typeof Automations>;
export const DEFAULT_AUTOMATIONS: Automations = {
  fixPipeline: true,
  reviewComments: true,
  reviewer: false,
  handoff: true,
  agentReady: false,
};
/** Label que coloca uma issue para os agentes (automação agentReady). */
export const AGENT_READY_LABEL = 'agent-ready';
export const AutomationsInput = Automations.partial();

/** Modelo e limites dos agentes, ajustáveis na tela (o padrão vem das variáveis de ambiente). */
export const AgentSettings = z.object({
  /** Modelo dos agentes (`opus`, `sonnet`, `haiku` ou um id); nulo = padrão do Claude Code. */
  model: z.string().trim().min(1).max(100).nullable(),
  /** Agentes rodando ao mesmo tempo; o resto fica na fila. */
  maxRunning: z.number().int().min(1).max(20),
  /** Sub-agentes trabalhando ao mesmo tempo para um mesmo agente (spawn_agent recusa além disso). */
  maxChildren: z.number().int().min(1).max(20),
  /** Minutos de um agente antes de ser pausado. */
  maxAgentMinutes: z.number().int().min(1).max(600),
  /** Tokens (entrada + saída) de uma árvore de agentes. */
  treeTokenBudget: z.number().int().min(10_000).max(500_000_000),
  /** Tokens recomendados no contexto de um agente (medidor). */
  contextBudget: z.number().int().min(5_000).max(1_000_000),
  /** Agentes novos começam no modo automático (sem pedir permissão a cada passo). */
  autoMode: z.boolean(),
});
export type AgentSettings = z.infer<typeof AgentSettings>;
/** PUT /api/settings/agents: só os campos enviados mudam; `null` volta ao padrão. */
export const AgentSettingsInput = z.object(
  Object.fromEntries(
    Object.entries(AgentSettings.shape).map(([k, v]) => [k, (v as z.ZodType).nullable().optional()]),
  ) as { [K in keyof AgentSettings]: z.ZodOptional<z.ZodNullable<(typeof AgentSettings.shape)[K]>> },
);
export type AgentSettingsInput = z.infer<typeof AgentSettingsInput>;
