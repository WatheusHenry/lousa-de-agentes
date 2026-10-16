import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Por quanto tempo o mesmo token vale entre reinícios do bridge. */
const REUSE_MS = 7 * 86_400_000;

/**
 * Token aleatório exigido em toda chamada HTTP da API e no WebSocket. Sobrevive a reinícios do
 * bridge (por uma semana), para a página aberta reconectar sozinha depois de um crash ou do
 * `tsx watch` recarregar.
 */
export class Session {
  readonly token: string;

  constructor(token?: string) {
    this.token = token ?? randomBytes(32).toString('hex');
  }

  /** Reaproveita o token publicado pela execução anterior, se ainda for recente. */
  static load(home: string): Session {
    const file = join(home, 'session.json');
    try {
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs < REUSE_MS) {
        const { token } = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
        if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) return new Session(token);
      }
    } catch {
      // arquivo corrompido: token novo
    }
    return new Session();
  }

  check(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Publica o token num arquivo 0600 da pasta de dados, para o servidor do Vite (dev) injetar
   * no index.html. Páginas de outras origens não conseguem ler esse HTML.
   */
  publish(home: string, port: number): void {
    const file = join(home, 'session.json');
    writeFileSync(file, JSON.stringify({ port, token: this.token, pid: process.pid }), { mode: 0o600 });
  }
}
