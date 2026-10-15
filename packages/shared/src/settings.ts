import { z } from 'zod';
import { GitLabProject, GitLabUser } from './gitlab.ts';

export const GitLabMode = z.enum(['gitlab', 'demo']);
export type GitLabMode = z.infer<typeof GitLabMode>;

/** POST /settings/gitlab. O token é opcional para permitir mudar só a URL ou a pasta. */
export const GitLabSettingsInput = z.object({
  mode: GitLabMode.default('gitlab'),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  token: z.string().trim().min(8).max(512).optional(),
  reposDir: z.string().trim().min(1).max(1024).optional(),
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
  configured: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsView>;
