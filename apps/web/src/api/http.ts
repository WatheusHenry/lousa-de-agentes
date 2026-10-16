import {
  SESSION_HEADER,
  SESSION_META,
  type GitLabProject,
  type GitLabSettingsInput,
  type Issue,
  type IssueComment,
  type MrDiffFile,
  type SettingsView,
  type StateSnapshot,
} from '@agent-canvas/shared';

/** Token de sessão do bridge, injetado no index.html (meta tag). */
export function sessionToken(): string | null {
  return document.querySelector<HTMLMetaElement>(`meta[name="${SESSION_META}"]`)?.content || null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionToken();
  if (!token) throw new ApiError('O bridge não está rodando. Rode pnpm dev e recarregue a página.', 0);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        [SESSION_HEADER]: token,
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('Sem conexão com o bridge. Ele está rodando?', 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Erro ${res.status}`, res.status);
  return body as T;
}

export const api = {
  state: () => call<StateSnapshot>('/api/state'),
  settings: () => call<SettingsView>('/api/settings'),
  saveGitLab: (input: GitLabSettingsInput) =>
    call<SettingsView>('/api/settings/gitlab', { method: 'POST', body: JSON.stringify(input) }),
  searchProjects: (search: string) =>
    call<GitLabProject[]>(`/api/gitlab/projects?search=${encodeURIComponent(search)}`),
  selectProjects: (projectIds: number[]) =>
    call<SettingsView>('/api/settings/projects', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  issues: () => call<{ issues: Issue[]; errors: { project: string; error: string }[] }>('/api/gitlab/issues'),
  rawEvents: (agentId: string) => call<string[]>(`/api/agents/${encodeURIComponent(agentId)}/raw`),
  comments: (projectId: number, iid: number) =>
    call<IssueComment[]>(`/api/gitlab/issues/${projectId}/${iid}/comments`),
  mrDiff: (ref: string) => call<MrDiffFile[]>(`/api/mrs/${encodeURIComponent(ref)}/diff`),
  mrComments: (ref: string) => call<IssueComment[]>(`/api/mrs/${encodeURIComponent(ref)}/comments`),
};
