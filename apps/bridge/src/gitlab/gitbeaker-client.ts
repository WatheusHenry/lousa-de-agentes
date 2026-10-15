import { Gitlab } from '@gitbeaker/rest';
import {
  issueRef,
  type GitLabProject,
  type GitLabUser,
  type Issue,
  type IssueComment,
} from '@agent-canvas/shared';
import { GitLabError, type GitLabClient } from './client.ts';

type Raw = Record<string, unknown>;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/** Cliente real, via API REST v4 com token pessoal (escopo `api`). */
export class GitbeakerClient implements GitLabClient {
  private readonly api: InstanceType<typeof Gitlab>;

  constructor(baseUrl: string, token: string) {
    this.api = new Gitlab({ host: baseUrl.replace(/\/+$/, ''), token, camelize: false });
  }

  async currentUser(): Promise<GitLabUser> {
    const u = (await this.call(() => this.api.Users.showCurrentUser())) as unknown as Raw;
    return {
      id: num(u.id),
      username: str(u.username),
      name: str(u.name),
      avatarUrl: (u.avatar_url as string | null) ?? null,
      webUrl: str(u.web_url),
    };
  }

  async searchProjects(search?: string): Promise<GitLabProject[]> {
    const list = (await this.call(() =>
      this.api.Projects.all({
        membership: true,
        simple: true,
        search: search || undefined,
        orderBy: 'last_activity_at',
        sort: 'desc',
        perPage: 50,
        maxPages: 1,
      }),
    )) as unknown as Raw[];
    return list.map(toProject);
  }

  async getProject(projectId: number): Promise<GitLabProject> {
    return toProject((await this.call(() => this.api.Projects.show(projectId))) as unknown as Raw);
  }

  async listOpenIssues(project: GitLabProject): Promise<Issue[]> {
    const list = (await this.call(() =>
      this.api.Issues.all({
        projectId: project.id,
        state: 'opened',
        orderBy: 'updated_at',
        sort: 'desc',
        perPage: 100,
        maxPages: 3,
      }),
    )) as unknown as Raw[];
    return list.map((i) => ({
      ref: issueRef(project.id, num(i.iid)),
      projectId: project.id,
      projectPath: project.pathWithNamespace,
      iid: num(i.iid),
      title: str(i.title),
      description: str(i.description),
      labels: Array.isArray(i.labels) ? (i.labels as unknown[]).map(String) : [],
      author: str((i.author as Raw | undefined)?.username, 'desconhecido'),
      state: i.state === 'closed' ? 'closed' : 'opened',
      updatedAt: str(i.updated_at),
      commentCount: num(i.user_notes_count ?? 0),
      webUrl: str(i.web_url),
    }));
  }

  async listIssueComments(projectId: number, iid: number): Promise<IssueComment[]> {
    const list = (await this.call(() =>
      this.api.IssueNotes.all(projectId, iid, {
        sort: 'asc',
        orderBy: 'created_at',
        perPage: 100,
        maxPages: 5,
      }),
    )) as unknown as Raw[];
    return list
      .filter((n) => !n.system)
      .map((n) => ({
        id: num(n.id),
        author: str((n.author as Raw | undefined)?.username, 'desconhecido'),
        body: str(n.body),
        createdAt: str(n.created_at),
        isAgent: false,
      }));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toGitLabError(err);
    }
  }
}

function toProject(p: Raw): GitLabProject {
  return {
    id: num(p.id),
    pathWithNamespace: str(p.path_with_namespace),
    name: str(p.name),
    description: (p.description as string | null) ?? null,
    defaultBranch: (p.default_branch as string | null) ?? null,
    webUrl: str(p.web_url),
  };
}

function toGitLabError(err: unknown): GitLabError {
  const e = err as { cause?: { response?: { status?: number } }; message?: string; code?: string };
  const status = e.cause?.response?.status;
  if (status === 401) return new GitLabError('Token inválido, expirado ou revogado.', 401);
  if (status === 403)
    return new GitLabError('O token não tem permissão. Use um token com escopo "api".', 403);
  if (status === 404) return new GitLabError('Não encontrado no GitLab. Confira a URL da instância.', 404);
  if (status) return new GitLabError(`O GitLab respondeu com erro ${status}.`, status);
  return new GitLabError('Não foi possível conectar ao GitLab. Confira a URL e a rede.');
}
