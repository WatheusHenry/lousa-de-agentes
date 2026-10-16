import { z } from 'zod';

export const GitLabUser = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
  webUrl: z.string().optional(),
});
export type GitLabUser = z.infer<typeof GitLabUser>;

export const GitLabProject = z.object({
  id: z.number(),
  pathWithNamespace: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  webUrl: z.string(),
});
export type GitLabProject = z.infer<typeof GitLabProject>;

/** Referência estável de uma issue: `<projectId>#<iid>`. */
export const IssueRef = z.string().regex(/^\d+#\d+$/, 'formato esperado: <projectId>#<iid>');
export type IssueRef = z.infer<typeof IssueRef>;

export const issueRef = (projectId: number, iid: number): IssueRef => `${projectId}#${iid}`;

export function parseIssueRef(ref: string): { projectId: number; iid: number } {
  const m = /^(\d+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`referência de issue inválida: ${ref}`);
  return { projectId: Number(m[1]), iid: Number(m[2]) };
}

export const Issue = z.object({
  ref: IssueRef,
  projectId: z.number(),
  projectPath: z.string(),
  iid: z.number(),
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  state: z.enum(['opened', 'closed']),
  updatedAt: z.string(),
  commentCount: z.number(),
  webUrl: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const IssueComment = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** Comentário escrito por um agente do canvas (Fase 3 em diante). */
  isAgent: z.boolean(),
});
export type IssueComment = z.infer<typeof IssueComment>;
