import type {
  GitLabProject,
  GitLabUser,
  Issue,
  IssueComment,
  MrDiffFile,
  PipelineStatus,
} from '@agent-canvas/shared';

/** O que o GitLab diz de um MR (o resto, como o agente que abriu, é do canvas). */
export interface GitLabMr {
  iid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  pipelineStatus: PipelineStatus;
  webUrl: string;
  updatedAt: string;
}

/**
 * Tudo o que o bridge precisa do GitLab. O resto do código depende só desta interface,
 * para os testes (e o modo demonstração) usarem a implementação com dados de exemplo.
 */
export interface GitLabClient {
  currentUser(): Promise<GitLabUser>;
  /** Projetos em que o usuário é membro, filtrados por texto. */
  searchProjects(search?: string): Promise<GitLabProject[]>;
  getProject(projectId: number): Promise<GitLabProject>;
  listOpenIssues(project: GitLabProject): Promise<Issue[]>;
  listIssueComments(projectId: number, iid: number): Promise<IssueComment[]>;
  commentOnIssue(projectId: number, iid: number, body: string): Promise<void>;

  createMergeRequest(
    projectId: number,
    opts: { sourceBranch: string; targetBranch: string; title: string; description: string },
  ): Promise<GitLabMr>;
  getMergeRequest(projectId: number, iid: number): Promise<GitLabMr>;
  listMergeRequestDiffs(projectId: number, iid: number): Promise<MrDiffFile[]>;
  listMergeRequestComments(projectId: number, iid: number): Promise<IssueComment[]>;
  commentOnMergeRequest(projectId: number, iid: number, body: string): Promise<void>;
  mergeMergeRequest(projectId: number, iid: number): Promise<GitLabMr>;
  /** Logs (trace) dos jobs que falharam no pipeline mais recente do MR. */
  failedJobLogs(projectId: number, iid: number): Promise<JobLog[]>;
}

export interface JobLog {
  jobId: number;
  name: string;
  stage: string;
  trace: string;
}

/** Erro do GitLab com mensagem pronta para mostrar ao usuário (nunca contém o token). */
export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}
