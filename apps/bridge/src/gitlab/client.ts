import type { GitLabProject, GitLabUser, Issue, IssueComment } from '@agent-canvas/shared';

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
