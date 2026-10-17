import { z } from 'zod';

export const GitLabUser = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
  webUrl: z.string().optional(),
});
export type GitLabUser = z.infer<typeof GitLabUser>;

/** Onde fica o remoto `origin` de um repositório local (para enviar o branch e abrir MR/PR). */
export const RemoteKind = z.enum(['gitlab', 'github', 'other']);
export type RemoteKind = z.infer<typeof RemoteKind>;

export const GitLabProject = z.object({
  /** Projeto do GitLab; negativo para repositório local (fora do GitLab do app). */
  id: z.number(),
  pathWithNamespace: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  webUrl: z.string(),
  /** Repositório local, escolhido pela pasta: sem issues nem MR pela API. */
  local: z.boolean().optional(),
  /** Remoto `origin` do repositório local, se houver. */
  remote: RemoteKind.nullable().optional(),
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

/** Referência estável de um MR: `<projectId>!<iid>`. */
export const MrRef = z.string().regex(/^-?\d+!\d+$/, 'formato esperado: <projectId>!<iid>');
export type MrRef = z.infer<typeof MrRef>;
export const mrRef = (projectId: number, iid: number): MrRef => `${projectId}!${iid}`;
export function parseMrRef(ref: string): { projectId: number; iid: number } {
  const m = /^(-?\d+)!(\d+)$/.exec(ref);
  if (!m) throw new Error(`referência de MR inválida: ${ref}`);
  return { projectId: Number(m[1]), iid: Number(m[2]) };
}

export const PipelineStatus = z.enum([
  'none',
  'created',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
]);
export type PipelineStatus = z.infer<typeof PipelineStatus>;

export const MergeRequest = z.object({
  ref: MrRef,
  projectId: z.number(),
  projectPath: z.string(),
  iid: z.number(),
  title: z.string(),
  description: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  state: z.enum(['opened', 'merged', 'closed', 'locked']),
  pipelineStatus: PipelineStatus,
  webUrl: z.string(),
  additions: z.number(),
  deletions: z.number(),
  /** Agente que abriu o MR pelo canvas, se foi um agente. */
  agentId: z.string().nullable(),
  issueRef: z.string().nullable(),
  updatedAt: z.string(),
  /**
   * Repositório local: o branch fica para revisão no canvas, sem MR no GitLab. Depois de
   * "Enviar", `remoteUrl` aponta para o MR (GitLab) ou para a página de abrir o PR (GitHub).
   */
  remoteUrl: z.string().nullable().optional(),
  publishedTo: RemoteKind.nullable().optional(),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

/** Repositório local (id negativo): a revisão e o merge acontecem no próprio clone. */
export const isLocalProject = (projectId: number) => projectId < 0;

export const MrDiffFile = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  diff: z.string(),
  newFile: z.boolean(),
  deletedFile: z.boolean(),
  renamedFile: z.boolean(),
});
export type MrDiffFile = z.infer<typeof MrDiffFile>;

/** Contagem de linhas somadas e removidas nos diffs. */
export function diffStat(files: { diff: string }[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files)
    for (const line of f.diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
  return { additions, deletions };
}

/**
 * Comentários feitos por agentes saem com o token do usuário; este cabeçalho os identifica
 * no GitLab e permite marcá-los como "agente" ao ler a discussão.
 */
export const agentNoteHeader = (agentName: string) => `🤖 **${agentName}** · Agent Canvas\n\n`;
export function parseAgentNote(body: string): { agent: string; body: string } | null {
  const m = /^🤖 \*\*(.+?)\*\* · Agent Canvas\n\n([\s\S]*)$/.exec(body);
  return m ? { agent: m[1]!, body: m[2]! } : null;
}

/**
 * Repositórios que a issue parece tocar: o projeto dela e os projetos escolhidos citados no
 * título ou na descrição (pelo nome ou pelo caminho).
 */
export function detectRepos(
  issue: { projectId: number; title: string; description: string },
  projects: { id: number; name: string; pathWithNamespace: string }[],
): number[] {
  const text = `${issue.title}\n${issue.description}`.toLowerCase();
  const cited = projects.filter((p) => {
    if (p.id === issue.projectId) return false;
    const names = [p.pathWithNamespace.toLowerCase(), p.name.toLowerCase()];
    return names.some((n) =>
      new RegExp(`(^|[^\\w/-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text),
    );
  });
  return [issue.projectId, ...cited.map((p) => p.id)];
}
