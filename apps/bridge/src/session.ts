import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Token aleatório por execução do bridge, exigido em toda chamada HTTP da API e no WebSocket. */
export class Session {
  readonly token = randomBytes(32).toString('hex');

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
  publish(home: string, port: number): () => void {
    const file = join(home, 'session.json');
    writeFileSync(file, JSON.stringify({ port, token: this.token, pid: process.pid }), { mode: 0o600 });
    return () => rmSync(file, { force: true });
  }
}
