import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type {
  GitLabMode,
  GitLabProject,
  GitLabSettingsInput,
  GitLabUser,
  SettingsView,
} from '@agent-canvas/shared';
import { GitLabSettingsInput as InputSchema } from '@agent-canvas/shared';
import type { Db } from './db/index.ts';
import { issueCache, repo, setting } from './db/schema.ts';
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
      configured: mode === 'demo' || (!!tok && !!user),
    };
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
    if (input.reposDir !== undefined) {
      reposDir = resolve(input.reposDir.replace(/^~(?=$|\/)/, homedir()));
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
    return this.view();
  }

  /** Grava os projetos escolhidos, buscando os dados de cada um no GitLab. */
  async selectProjects(projectIds: number[]): Promise<SettingsView> {
    const client = this.client();
    const projects = await Promise.all(projectIds.map((id) => client.getProject(id)));
    const reposDir = this.view().reposDir;
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
            localPath: findLocalClone(reposDir, p),
          })
          .run();
      }
    });
    return this.view();
  }

  repos() {
    return this.db.select().from(repo).all();
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

/** Procura o clone local do projeto em <reposDir>/<nome> ou <reposDir>/<grupo>/<nome>. */
function findLocalClone(reposDir: string, p: GitLabProject): string | null {
  if (!reposDir) return null;
  for (const candidate of [join(reposDir, p.name), join(reposDir, p.pathWithNamespace)]) {
    if (existsSync(join(candidate, '.git'))) return candidate;
  }
  return null;
}
