import { Gitlab } from '@gitbeaker/rest';
import {
  issueRef,
  parseAgentNote,
  PipelineStatus,
  type GitLabProject,
  type GitLabUser,
  type Issue,
  type IssueComment,
  type MrDiffFile,
} from '@agent-canvas/shared';
import { GitLabError, type GitLabClient, type GitLabMr, type JobLog } from './client.ts';

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
    return toComments(list);
  }

  async commentOnIssue(projectId: number, iid: number, body: string): Promise<void> {
    await this.call(() => this.api.IssueNotes.create(projectId, iid, body));
  }

  async createMergeRequest(
    projectId: number,
    o: { sourceBranch: string; targetBranch: string; title: string; description: string },
  ): Promise<GitLabMr> {
    const mr = (await this.call(() =>
      this.api.MergeRequests.create(projectId, o.sourceBranch, o.targetBranch, o.title, {
        description: o.description,
        removeSourceBranch: true,
      }),
    )) as unknown as Raw;
    return toMr(mr);
  }

  async getMergeRequest(projectId: number, iid: number): Promise<GitLabMr> {
    return toMr((await this.call(() => this.api.MergeRequests.show(projectId, iid))) as unknown as Raw);
  }

  async failedJobLogs(projectId: number, iid: number): Promise<JobLog[]> {
    const mr = (await this.call(() => this.api.MergeRequests.show(projectId, iid))) as unknown as Raw;
    const pipe = (mr.head_pipeline ?? mr.pipeline) as Raw | null | undefined;
    if (!pipe?.id) return [];
    const jobs = (await this.call(() =>
      this.api.Jobs.all(projectId, { pipelineId: num(pipe.id), scope: 'failed' as never, perPage: 20 }),
    )) as unknown as Raw[];
    const out: JobLog[] = [];
    for (const j of jobs.slice(0, 3)) {
      const trace = (await this.call(() => this.api.Jobs.showLog(projectId, num(j.id)))) as unknown as string;
      out.push({ jobId: num(j.id), name: str(j.name), stage: str(j.stage), trace: String(trace ?? '') });
    }
    return out;
  }

  async listMergeRequestDiffs(projectId: number, iid: number): Promise<MrDiffFile[]> {
    const list = (await this.call(() =>
      this.api.MergeRequests.allDiffs(projectId, iid, { perPage: 100, maxPages: 3 }),
    )) as unknown as Raw[];
    return list.map((d) => ({
      oldPath: str(d.old_path),
      newPath: str(d.new_path),
      diff: str(d.diff),
      newFile: !!d.new_file,
      deletedFile: !!d.deleted_file,
      renamedFile: !!d.renamed_file,
    }));
  }

  async listMergeRequestComments(projectId: number, iid: number): Promise<IssueComment[]> {
    const list = (await this.call(() =>
      this.api.MergeRequestNotes.all(projectId, iid, {
        sort: 'asc',
        orderBy: 'created_at',
        perPage: 100,
        maxPages: 5,
      }),
    )) as unknown as Raw[];
    return toComments(list);
  }

  async commentOnMergeRequest(projectId: number, iid: number, body: string): Promise<void> {
    await this.call(() => this.api.MergeRequestNotes.create(projectId, iid, body));
  }

  async mergeMergeRequest(projectId: number, iid: number): Promise<GitLabMr> {
    return toMr((await this.call(() => this.api.MergeRequests.merge(projectId, iid))) as unknown as Raw);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toGitLabError(err);
    }
  }
}

function toComments(list: Raw[]): IssueComment[] {
  return list
    .filter((n) => !n.system)
    .map((n) => {
      const agent = parseAgentNote(str(n.body));
      return {
        id: num(n.id),
        author: agent?.agent ?? str((n.author as Raw | undefined)?.username, 'desconhecido'),
        body: agent?.body ?? str(n.body),
        createdAt: str(n.created_at),
        isAgent: !!agent,
      };
    });
}

function toMr(m: Raw): GitLabMr {
  const pipe = (m.head_pipeline ?? m.pipeline) as Raw | null | undefined;
  const status = PipelineStatus.safeParse(pipe?.status);
  const state = str(m.state);
  return {
    iid: num(m.iid),
    title: str(m.title),
    description: str(m.description),
    sourceBranch: str(m.source_branch),
    targetBranch: str(m.target_branch),
    state: state === 'merged' || state === 'closed' || state === 'locked' ? state : 'opened',
    pipelineStatus: pipe ? (status.success ? status.data : 'pending') : 'none',
    webUrl: str(m.web_url),
    updatedAt: str(m.updated_at),
  };
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
  if (status === 405 || status === 406 || status === 422) {
    const msg = (e.cause as { description?: string } | undefined)?.description;
    return new GitLabError(`O GitLab recusou a operação${msg ? `: ${msg}` : '.'}`, status);
  }
  if (status === 409) return new GitLabError('Já existe um MR aberto para este branch.', 409);
  if (status) return new GitLabError(`O GitLab respondeu com erro ${status}.`, status);
  return new GitLabError('Não foi possível conectar ao GitLab. Confira a URL e a rede.');
}
