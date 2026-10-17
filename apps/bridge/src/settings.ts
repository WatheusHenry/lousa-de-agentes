import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type {
  AgentSettings,
  AgentSettingsInput,
  GitLabMode,
  GitLabProject,
  GitLabSettingsInput,
  GitLabUser,
  SettingsView,
} from '@agent-canvas/shared';
import {
  DEFAULT_AUTOMATIONS,
  GitLabSettingsInput as InputSchema,
  type Automations,
} from '@agent-canvas/shared';
import type { Db } from './db/index.ts';
import { issueCache, repo, setting } from './db/schema.ts';
import { cloneOfOtherProject, cloneRepo, cloneUrls, matchClone, scanClones } from './git/discover.ts';
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

/** Configurações do GitLab: URL e pasta no banco, token só no SecretStore. */
export class SettingsService {
  private cachedClient: { key: string; client: GitLabClient } | null = null;
  /** Padrões dos agentes (variáveis de ambiente ou do app), definidos pelo servidor ao subir. */
  private agentDefaults: AgentSettings = {
    model: null,
    maxRunning: 4,
    maxAgentMinutes: 60,
    treeTokenBudget: 5_000_000,
    contextBudget: 60_000,
  };

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly makeClient: ClientFactory,
  ) {}

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
      projects: this.projects(),
      clones: this.db
        .select()
        .from(repo)
        .all()
        .map((r) => ({
          projectId: r.gitlabProjectId,
          path: r.localPath,
          manual: !!this.overrides()[r.gitlabProjectId],
        })),
      configured: mode === 'demo' || (!!tok && !!user),
      automations: this.automations(),
      agents: this.agentSettings(),
      agentDefaults: this.agentDefaults,
      trustedRepos: this.trustedRepos(),
    };
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

  projects(): GitLabProject[] {
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
      }));
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

    let user: GitLabUser;
    let baseUrl = current.baseUrl;
    if (input.mode === 'demo') {
      user = DEMO_USER;
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

    if (input.mode !== current.mode || baseUrl !== current.baseUrl) {
      this.db.delete(repo).run();
      this.db.delete(issueCache).run();
    }
    this.set('mode', input.mode);
    this.set('baseUrl', baseUrl);
    this.set('reposDir', reposDir);
    this.set('user', user);
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

  /** Grava os projetos escolhidos, buscando os dados de cada um no GitLab. */
  async selectProjects(projectIds: number[]): Promise<SettingsView> {
    const client = this.client();
    const projects = await Promise.all(projectIds.map((id) => client.getProject(id)));
    this.db.transaction((tx) => {
      tx.delete(repo).run();
      for (const p of projects) {
        tx.insert(repo)
          .values({
            gitlabProjectId: p.id,
            pathWithNamespace: p.pathWithNamespace,
            name: p.name,
            description: p.description,
            defaultBranch: p.defaultBranch,
            webUrl: p.webUrl,
          })
          .run();
      }
    });
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
    for (const r of this.repos()) {
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
