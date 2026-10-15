import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN_ENV = 'AGENT_CANVAS_GITLAB_TOKEN';

/**
 * Guarda o token do GitLab fora do banco: num arquivo `secrets.json` com permissão 0600
 * na pasta de dados do app, ou na variável de ambiente AGENT_CANVAS_GITLAB_TOKEN (ex.: .env local).
 * A variável de ambiente tem prioridade e nunca é gravada em disco pelo app.
 */
export class SecretStore {
  private readonly file: string;

  constructor(
    home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(home, 'secrets.json');
  }

  gitlabToken(): { token: string; source: 'env' | 'secrets-file' } | null {
    const fromEnv = this.env[TOKEN_ENV]?.trim();
    if (fromEnv) return { token: fromEnv, source: 'env' };
    const stored = this.read().gitlabToken;
    return stored ? { token: stored, source: 'secrets-file' } : null;
  }

  setGitlabToken(token: string | null): void {
    const data = this.read();
    if (token) data.gitlabToken = token;
    else delete data.gitlabToken;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private read(): { gitlabToken?: string } {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as { gitlabToken?: string };
    } catch {
      return {};
    }
  }
}
