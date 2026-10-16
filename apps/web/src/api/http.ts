import {
  SESSION_HEADER,
  SESSION_META,
  type AgentContext,
  type Automations,
  type GitLabProject,
  type GitLabSettingsInput,
  type Issue,
  type IssueComment,
  type MrDiffFile,
  type SettingsView,
  type StateSnapshot,
} from '@agent-canvas/shared';

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  isRepo: boolean;
  native: boolean;
  entries: { name: string; path: string; isRepo: boolean }[];
}

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
  dirs: (path?: string, hidden = false) =>
    call<DirListing>(`/api/fs/dirs?path=${encodeURIComponent(path ?? '')}${hidden ? '&hidden=1' : ''}`),
  pickNative: (title: string, start?: string) =>
    call<{ path: string | null }>('/api/fs/pick', { method: 'POST', body: JSON.stringify({ title, start }) }),
  agentContext: (agentId: string) => call<AgentContext>(`/api/agents/${encodeURIComponent(agentId)}/context`),
  agentFiles: (agentId: string, q: string) =>
    call<string[]>(`/api/agents/${encodeURIComponent(agentId)}/files?q=${encodeURIComponent(q)}`),
  setAutomations: (patch: Partial<Automations>) =>
    call<SettingsView>('/api/settings/automations', { method: 'PUT', body: JSON.stringify(patch) }),
  rescanRepos: () => call<SettingsView>('/api/repos/rescan', { method: 'POST' }),
  setRepoPath: (projectId: number, path: string | null) =>
    call<SettingsView>(`/api/repos/${projectId}/path`, { method: 'PUT', body: JSON.stringify({ path }) }),
  cloneRepo: (projectId: number) => call<SettingsView>(`/api/repos/${projectId}/clone`, { method: 'POST' }),
  mrDiff: (ref: string) => call<MrDiffFile[]>(`/api/mrs/${encodeURIComponent(ref)}/diff`),
  mrComments: (ref: string) => call<IssueComment[]>(`/api/mrs/${encodeURIComponent(ref)}/comments`),
};
