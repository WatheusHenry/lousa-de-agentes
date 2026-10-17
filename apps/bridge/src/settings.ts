import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { eq, min } from 'drizzle-orm';
import type {
  AgentSettings,
  AgentSettingsInput,
  GitLabMode,
  GitLabProject,
  GitLabSettingsInput,
  GitLabUser,
  SettingsView,
  WorkspaceInfo,
} from '@agent-canvas/shared';
import {
  DEFAULT_AUTOMATIONS,
  GitLabSettingsInput as InputSchema,
  type Automations,
} from '@agent-canvas/shared';
import type { Db } from './db/index.ts';
import { issueCache, repo, setting, workspace } from './db/schema.ts';
import { cloneOfOtherProject, cloneRepo, cloneUrls, matchClone, scanClones } from './git/discover.ts';
import { currentBranch, isGitRepo, originUrl, remoteKind, remoteWebUrl } from './git/local.ts';
import { GitError } from './git/worktree.ts';
import { GitLabError, type GitLabClient } from './gitlab/client.ts';
import { DEMO_USER, MockGitLabClient } from './gitlab/mock-client.ts';
import type { SecretStore } from './secrets.ts';

export type ClientFactory = (baseUrl: string, token: string) => GitLabClient;

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const DEFAULT_BASE_URL = 'https://gitlab.com';
/** Workspace criado pela migração com o canvas que já existia. */
export const DEFAULT_WORKSPACE = 'default';

/** Configurações do GitLab: URL e pasta no banco, token só no SecretStore. */
export class SettingsService {
  private cachedClient: { key: string; client: GitLabClient } | null = null;
  /** Padrões dos agentes (variáveis de ambiente ou do app), definidos pelo servidor ao subir. */
  private agentDefaults: AgentSettings = {
    model: null,
    maxRunning: 4,
    maxChildren: 4,
    maxAgentMinutes: 60,
    treeTokenBudget: 5_000_000,
    contextBudget: 60_000,
    autoMode: true,
  };

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly makeClient: ClientFactory,
  ) {}

  /** Agentes trabalhando em cada workspace (o servidor liga ao supervisor). */
  busyByWorkspace: () => Map<string, number> = () => new Map();

  view(): SettingsView {
    const mode = this.get<GitLabMode>('mode') ?? 'gitlab';
    const tok = this.secrets.gitlabToken();
    const user = this.get<GitLabUser>('user');
    return {
      mode,
      baseUrl: this.get<string>('baseUrl') ?? DEFAULT_BASE_URL,
      reposDir: this.get<string>('reposDir') ?? '',
      hasToken: !!tok,
      tokenSource: tok?.source ?? null,
      user: user ?? null,
      projects: this.workspaceProjects(),
      clones: this.db
        .select()
        .from(repo)
        .all()
        .map((r) => ({
          projectId: r.gitlabProjectId,
          path: r.localPath,
          manual: !!this.overrides()[r.gitlabProjectId],
        })),
      configured: mode === 'demo' || mode === 'local' || (!!tok && !!user),
      automations: this.automations(),
      agents: this.agentSettings(),
      agentDefaults: this.agentDefaults,
      trustedRepos: this.trustedRepos(),
      workspaceId: this.activeWorkspace(),
      workspaces: this.workspaces(),
    };
  }

  // ---------- workspaces ----------

  /** Workspace aberto, em memória: é lido a cada mensagem para o navegador. */
  private activeWs: string | null = null;

  /** Workspace aberto. Se o gravado sumiu, cai no principal (ou no primeiro que existir). */
  activeWorkspace(): string {
    this.activeWs ??= this.readActiveWorkspace();
    return this.activeWs;
  }

  private readActiveWorkspace(): string {
    const id = this.get<string>('activeWorkspace');
    const rows = this.db.select({ id: workspace.id }).from(workspace).all();
    if (id && rows.some((r) => r.id === id)) return id;
    return rows.find((r) => r.id === DEFAULT_WORKSPACE)?.id ?? rows[0]?.id ?? this.ensureWorkspace();
  }

  /** Banco sem workspace nenhum (não deveria acontecer depois da migração): cria o principal. */
  private ensureWorkspace(): string {
    this.db
      .insert(workspace)
      .values({
        id: DEFAULT_WORKSPACE,
        name: 'Principal',
        projectIds: this.repos().map((r) => r.gitlabProjectId),
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    return DEFAULT_WORKSPACE;
  }

  workspaces(): WorkspaceInfo[] {
    const known = new Set(this.repos().map((r) => r.gitlabProjectId));
    const busy = this.busyByWorkspace();
    return this.db
      .select()
      .from(workspace)
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((w) => ({
        id: w.id,
        name: w.name,
        projects: w.projectIds.filter((id) => known.has(id)).length,
        busy: busy.get(w.id) ?? 0,
      }));
  }

  /** Cria um workspace vazio e já o abre. */
  createWorkspace(name: string): SettingsView {
    const id = `w_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.db.insert(workspace).values({ id, name, projectIds: [], createdAt: new Date().toISOString() }).run();
    this.set('activeWorkspace', id);
    this.activeWs = null;
    return this.view();
  }

  renameWorkspace(id: string, name: string): SettingsView {
    const r = this.db.update(workspace).set({ name }).where(eq(workspace.id, id)).returning().get();
    if (!r) throw new SettingsError('Workspace não encontrado.', 404);
    return this.view();
  }

  switchWorkspace(id: string): SettingsView {
    if (!this.db.select().from(workspace).where(eq(workspace.id, id)).get())
      throw new SettingsError('Workspace não encontrado.', 404);
    this.set('activeWorkspace', id);
    this.activeWs = null;
    return this.view();
  }

  /** Apaga o workspace (o último não sai). Se era o aberto, abre outro. */
  deleteWorkspace(id: string): SettingsView {
    const all = this.workspaces();
    if (!all.some((w) => w.id === id)) throw new SettingsError('Workspace não encontrado.', 404);
    if (all.length === 1) throw new SettingsError('Este é o único workspace: crie outro antes de apagar.');
    const wasActive = this.activeWorkspace() === id;
    this.db.delete(workspace).where(eq(workspace.id, id)).run();
    if (wasActive) this.set('activeWorkspace', all.find((w) => w.id !== id)!.id);
    this.activeWs = null;
    this.dropOrphanRepos();
    return this.view();
  }

  /** Ids dos projetos escolhidos no workspace. */
  private workspaceProjectIds(id = this.activeWorkspace()): number[] {
    return this.db.select().from(workspace).where(eq(workspace.id, id)).get()?.projectIds ?? [];
  }

  private setWorkspaceProjectIds(ids: number[], id = this.activeWorkspace()): void {
    this.db
      .update(workspace)
      .set({ projectIds: [...new Set(ids)] })
      .where(eq(workspace.id, id))
      .run();
  }

  /** Workspace em que o projeto foi escolhido (o aberto, se estiver nele). */
  workspaceOfProject(projectId: number): string | null {
    const active = this.activeWorkspace();
    if (this.workspaceProjectIds(active).includes(projectId)) return active;
    return (
      this.db
        .select()
        .from(workspace)
        .all()
        .find((w) => w.projectIds.includes(projectId))?.id ?? null
    );
  }

  /** Projetos do workspace aberto: barra lateral, issues e configuração. */
  workspaceProjects(): GitLabProject[] {
    const ids = new Set(this.workspaceProjectIds());
    return this.projects().filter((p) => ids.has(p.id));
  }

  /** Projetos do GitLab do workspace aberto: a lista de issues da barra lateral. */
  workspaceGitlabProjects(): GitLabProject[] {
    return this.workspaceProjects().filter((p) => !p.local);
  }

  /** Repositório que nenhum workspace usa mais sai da tabela (a pasta e o git não mudam). */
  private dropOrphanRepos(): void {
    const used = new Set(
      this.db
        .select()
        .from(workspace)
        .all()
        .flatMap((w) => w.projectIds),
    );
    for (const r of this.repos())
      if (!used.has(r.gitlabProjectId)) this.db.delete(repo).where(eq(repo.id, r.id)).run();
  }

  setAgentDefaults(d: AgentSettings): void {
    this.agentDefaults = d;
  }

  /** Modelo e limites em uso: o que foi mudado na tela por cima dos padrões. */
  agentSettings(): AgentSettings {
    return { ...this.agentDefaults, ...this.get<Partial<AgentSettings>>('agentSettings') };
  }

  /** Muda só os campos enviados; `null` volta ao padrão. */
  setAgentSettings(patch: AgentSettingsInput): SettingsView {
    const merged: Record<string, unknown> = {
      ...this.get<Partial<AgentSettings>>('agentSettings'),
      ...patch,
    };
    // null volta ao padrão: o campo sai do que foi mudado na tela
    this.set(
      'agentSettings',
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined)),
    );
    return this.view();
  }

  /** Projetos em modo confiança (o trabalho comum no worktree não pede permissão). */
  trustedRepos(): number[] {
    const chosen = new Set(this.projects().map((p) => p.id));
    return (this.get<number[]>('trustedRepos') ?? []).filter((id) => chosen.has(id));
  }

  setTrusted(projectId: number, on: boolean): SettingsView {
    if (!this.projects().some((p) => p.id === projectId))
      throw new SettingsError('Projeto não escolhido.', 404);
    const cur = new Set(this.get<number[]>('trustedRepos') ?? []);
    if (on) cur.add(projectId);
    else cur.delete(projectId);
    this.set('trustedRepos', [...cur]);
    return this.view();
  }

  /** Projetos de todos os workspaces (os agentes de qualquer workspace continuam trabalhando). */
  projects(): GitLabProject[] {
    const baseUrl = this.get<string>('baseUrl');
    return this.db
      .select()
      .from(repo)
      .all()
      .map((r) => ({
        id: r.gitlabProjectId,
        pathWithNamespace: r.pathWithNamespace,
        name: r.name,
        description: r.description,
        defaultBranch: r.defaultBranch,
        webUrl: r.webUrl,
        ...(r.local
          ? { local: true, remote: r.localPath ? remoteKind(originUrl(r.localPath), baseUrl) : null }
          : {}),
      }));
  }

  /** Projetos do GitLab escolhidos em qualquer workspace (sem os locais): MRs e poller. */
  gitlabProjects(): GitLabProject[] {
    return this.projects().filter((p) => !p.local);
  }

  /** Há GitLab para consultar? (no modo local, ou sem token, não há) */
  hasGitLab(): boolean {
    const v = this.view();
    return v.configured && v.mode !== 'local';
  }

  /**
   * Repositório local escolhido pela pasta: entra no canvas com id negativo, sem precisar do
   * GitLab. O branch base dos agentes é o branch em que o clone está agora.
   */
  addLocalRepo(raw: string): SettingsView {
    const abs = expandHome(raw);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new SettingsError(`A pasta ${abs} não existe.`);
    if (!isGitRepo(abs)) throw new SettingsError(`${abs} não é um repositório git (falta a pasta .git).`);
    const path = realpathSync(abs);
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const dup = this.repos().find((r) => r.localPath && real(r.localPath) === path);
    if (dup) {
      // já escolhido em outro workspace: entra neste também
      if (!this.workspaceProjectIds().includes(dup.gitlabProjectId)) {
        this.setWorkspaceProjectIds([...this.workspaceProjectIds(), dup.gitlabProjectId]);
        return this.view();
      }
      throw new SettingsError(`${path} já está no canvas como ${dup.name}.`);
    }
    const remote = originUrl(path);
    const web = remote ? remoteWebUrl(remote) : null;
    const lowest =
      this.db
        .select({ v: min(repo.gitlabProjectId) })
        .from(repo)
        .get()?.v ?? 0;
    const id = Math.min(lowest, 0) - 1;
    const name = basename(path);
    this.db
      .insert(repo)
      .values({
        gitlabProjectId: id,
        pathWithNamespace: web ? new URL(web).pathname.replace(/^\/+/, '') : name,
        name,
        description: null,
        defaultBranch: currentBranch(path),
        webUrl: web ?? '',
        localPath: path,
        local: true,
      })
      .run();
    this.setWorkspaceProjectIds([...this.workspaceProjectIds(), id]);
    return this.view();
  }

  /** Tira um repositório local do canvas (a pasta e o git não mudam). */
  removeLocalRepo(projectId: number): SettingsView {
    const r = this.repoOf(projectId);
    if (!r.local) throw new SettingsError('Só repositórios locais saem por aqui.');
    // sai deste workspace; o registro só some quando nenhum outro o usa
    this.setWorkspaceProjectIds(this.workspaceProjectIds().filter((id) => id !== projectId));
    this.dropOrphanRepos();
    if (!this.repos().some((x) => x.id === r.id))
      this.set(
        'trustedRepos',
        (this.get<number[]>('trustedRepos') ?? []).filter((id) => id !== projectId),
      );
    return this.view();
  }

  /**
   * Valida o token com GET /user antes de gravar qualquer coisa. Se a validação falhar,
   * nada muda. Trocar de instância ou de modo limpa a seleção de projetos e o cache de issues.
   */
  async save(raw: GitLabSettingsInput): Promise<SettingsView> {
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) throw new SettingsError(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    const input = parsed.data;
    const current = this.view();

    let reposDir = current.reposDir;
    if (input.reposDir === '') reposDir = '';
    else if (input.reposDir !== undefined) {
      reposDir = expandHome(input.reposDir);
      if (!existsSync(reposDir) || !statSync(reposDir).isDirectory())
        throw new SettingsError(`A pasta ${reposDir} não existe.`);
    }

    let user: GitLabUser | null;
    let baseUrl = current.baseUrl;
    if (input.mode === 'demo') {
      user = DEMO_USER;
    } else if (input.mode === 'local') {
      user = null;
    } else {
      baseUrl = (input.baseUrl ?? current.baseUrl).replace(/\/+$/, '');
      const token = input.token ?? this.secrets.gitlabToken()?.token;
      if (!token) throw new SettingsError('Informe um token de acesso pessoal do GitLab.');
      try {
        user = await this.makeClient(baseUrl, token).currentUser();
      } catch (err) {
        throw new SettingsError(err instanceof GitLabError ? err.message : 'Falha ao validar o token.', 422);
      }
      if (input.token && this.secrets.gitlabToken()?.source !== 'env')
        this.secrets.setGitlabToken(input.token);
    }

    // os repositórios locais ficam: não dependem do GitLab
    if (input.mode !== current.mode || baseUrl !== current.baseUrl) {
      this.db.delete(repo).where(eq(repo.local, false)).run();
      this.db.delete(issueCache).run();
    }
    this.set('mode', input.mode);
    this.set('baseUrl', baseUrl);
    this.set('reposDir', reposDir);
    if (user) this.set('user', user);
    else this.db.delete(setting).where(eq(setting.key, 'user')).run();
    this.cachedClient = null;
    if (reposDir !== current.reposDir) this.locateClones();
    return this.view();
  }

  automations(): Automations {
    return { ...DEFAULT_AUTOMATIONS, ...this.get<Partial<Automations>>('automations') };
  }

  setAutomations(patch: Partial<Automations>): SettingsView {
    this.set('automations', { ...this.automations(), ...patch });
    return this.view();
  }

  /** Issues com a label agent-ready que a automação já tratou (não começam de novo). */
  agentReadySeen(): string[] {
    return this.get<string[]>('agentReadySeen') ?? [];
  }

  markAgentReadySeen(ref: string): void {
    this.set('agentReadySeen', [...this.agentReadySeen().filter((r) => r !== ref), ref].slice(-500));
  }

  /**
   * Grava os projetos escolhidos no workspace aberto, buscando os dados de cada um no GitLab. Os
   * repositórios locais do workspace ficam; os outros workspaces não mudam.
   */
  async selectProjects(projectIds: number[]): Promise<SettingsView> {
    const client = this.client();
    const projects = await Promise.all(projectIds.map((id) => client.getProject(id)));
    const locals = new Set(
      this.repos()
        .filter((r) => r.local)
        .map((r) => r.gitlabProjectId),
    );
    this.db.transaction((tx) => {
      for (const p of projects) {
        const values = {
          gitlabProjectId: p.id,
          pathWithNamespace: p.pathWithNamespace,
          name: p.name,
          description: p.description,
          defaultBranch: p.defaultBranch,
          webUrl: p.webUrl,
        };
        tx.insert(repo)
          .values(values)
          .onConflictDoUpdate({ target: repo.gitlabProjectId, set: values })
          .run();
      }
    });
    this.setWorkspaceProjectIds([
      ...this.workspaceProjectIds().filter((id) => locals.has(id)),
      ...projects.map((p) => p.id),
    ]);
    this.dropOrphanRepos();
    this.locateClones();
    return this.view();
  }

  repos() {
    return this.db.select().from(repo).all();
  }

  /** Onde procurar clones: a pasta configurada (4 níveis) ou a pasta pessoal (3 níveis). */
  private searchRoot(): { root: string; depth: number } {
    const dir = this.view().reposDir;
    return dir ? { root: dir, depth: 4 } : { root: homedir(), depth: 3 };
  }

  /**
   * Acha o clone de cada projeto pelo remoto do git (o nome da pasta não importa). Caminhos
   * informados à mão têm prioridade. Roda ao escolher projetos, ao mudar a pasta, no botão
   * "Procurar de novo" e quando um agente vai começar num projeto ainda sem clone.
   */
  locateClones(): void {
    const { root, depth } = this.searchRoot();
    const clones = scanClones(root, depth);
    const manual = this.overrides();
    for (const r of this.repos().filter((x) => !x.local)) {
      const m = manual[r.gitlabProjectId];
      const path =
        m && existsSync(join(m, '.git'))
          ? m
          : matchClone(clones, { pathWithNamespace: r.pathWithNamespace, name: r.name });
      this.db.update(repo).set({ localPath: path }).where(eq(repo.id, r.id)).run();
    }
  }

  /** Caminho do clone informado pelo usuário (null volta para a busca automática). */
  setClonePath(projectId: number, raw: string | null): SettingsView {
    const r = this.repoOf(projectId);
    const overrides = Object.fromEntries(
      Object.entries(this.overrides()).filter(([id]) => Number(id) !== projectId),
    ) as Record<number, string>;
    if (raw) {
      const path = expandHome(raw);
      if (!existsSync(join(path, '.git'))) throw new SettingsError(`${path} não é um repositório git.`);
      if (cloneOfOtherProject(path, r.pathWithNamespace) && this.view().mode === 'gitlab')
        throw new SettingsError(
          `O remoto de ${path} não aponta para ${r.pathWithNamespace}. Confira se é o clone certo.`,
        );
      overrides[projectId] = path;
    }
    this.set('clonePaths', overrides);
    this.locateClones();
    return this.view();
  }

  /** Clona o projeto na pasta dos repositórios (ou em ~/projetos), com as credenciais git do usuário. */
  async cloneProject(projectId: number): Promise<SettingsView> {
    const r = this.repoOf(projectId);
    if (r.localPath) throw new SettingsError(`${r.name} já tem clone em ${r.localPath}.`);
    const root = this.view().reposDir || join(homedir(), 'projetos');
    const dest = existsSync(join(root, r.name)) ? join(root, r.pathWithNamespace) : join(root, r.name);
    try {
      await cloneRepo(cloneUrls(r.webUrl), dest);
    } catch (err) {
      throw new SettingsError(err instanceof GitError ? err.message : 'Falha ao clonar.', 502);
    }
    this.setClonePath(projectId, dest);
    return this.view();
  }

  private repoOf(projectId: number) {
    const r = this.db.select().from(repo).where(eq(repo.gitlabProjectId, projectId)).get();
    if (!r) throw new SettingsError('Projeto não está entre os escolhidos.', 404);
    return r;
  }

  private overrides(): Record<number, string> {
    return this.get<Record<number, string>>('clonePaths') ?? {};
  }

  /** Cliente do GitLab conforme as configurações atuais. */
  client(): GitLabClient {
    const v = this.view();
    if (!v.configured) throw new SettingsError('Configure o GitLab primeiro.', 409);
    if (v.mode === 'local')
      throw new SettingsError('Sem GitLab configurado: o app está só com repositórios locais.', 409);
    if (v.mode === 'demo') return this.memo('demo', () => new MockGitLabClient());
    const tok = this.secrets.gitlabToken()!.token;
    return this.memo(`${v.baseUrl}\n${tok}`, () => this.makeClient(v.baseUrl, tok));
  }

  private memo(key: string, make: () => GitLabClient): GitLabClient {
    if (this.cachedClient?.key !== key) this.cachedClient = { key, client: make() };
    return this.cachedClient.client;
  }

  private get<T>(key: string): T | undefined {
    const row = this.db.select().from(setting).where(eq(setting.key, key)).get();
    return row?.value as T | undefined;
  }

  private set(key: string, value: unknown): void {
    this.db
      .insert(setting)
      .values({ key, value })
      .onConflictDoUpdate({ target: setting.key, set: { value } })
      .run();
  }
}

const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
