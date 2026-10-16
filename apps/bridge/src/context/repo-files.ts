import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_FILE_BYTES = 256 * 1024;

/** Arquivos versionados do repositório (git ls-files), em cache curto por pasta. */
const listCache = new Map<string, { at: number; files: string[] }>();
export async function listFiles(dir: string): Promise<string[]> {
  const hit = listCache.get(dir);
  if (hit && Date.now() - hit.at < 15_000) return hit.files;
  try {
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.startsWith('.agent-canvas/'));
    listCache.set(dir, { at: Date.now(), files });
    return files;
  } catch {
    return [];
  }
}

/** Busca simples por caminho: todas as palavras precisam aparecer; nome do arquivo pesa mais. */
export async function searchFiles(dir: string, query: string, limit = 30): Promise<string[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files = await listFiles(dir);
  if (!words.length) return files.slice(0, limit);
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    if (!words.every((w) => lf.includes(w))) continue;
    const base = lf.slice(lf.lastIndexOf('/') + 1);
    scored.push({ f, s: words.filter((w) => base.includes(w)).length * 10 - f.length / 100 });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

/** Lê um arquivo do repositório; recusa caminhos fora dele, `.git` e arquivos grandes ou binários. */
export function readRepoFile(dir: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Caminho inválido.');
  const full = resolve(dir, path);
  if (!existsSync(full)) throw new Error(`${path} não existe no repositório.`);
  const real = realpathSync(full);
  const rel = relative(realpathSync(dir), real);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git')
    throw new Error('Caminho fora do repositório.');
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`${path} não é um arquivo.`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${path} tem mais de 256 KB.`);
  const buf = readFileSync(real);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${path} parece binário.`);
  return buf.toString('utf8');
}

const tryRead = (dir: string, name: string, max = 12_000) => {
  try {
    const t = readRepoFile(dir, name);
    return t.length > max ? `${t.slice(0, max)}\n… (cortado)` : t;
  } catch {
    return null;
  }
};

/**
 * Índice do repositório (não o código): árvore até 3 níveis, README, CLAUDE.md e package.json.
 * O agente lê o resto sozinho.
 */
export async function repoIndex(dir: string): Promise<string> {
  const files = await listFiles(dir);
  const entries = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i <= Math.min(parts.length, 3); i++)
      entries.add(parts.slice(0, i).join('/') + (i < parts.length ? '/' : ''));
  }
  const tree = [...entries].sort();
  const shown = tree.slice(0, 400);
  const parts = [
    '### Árvore (até 3 níveis)',
    '',
    '```',
    ...shown,
    ...(tree.length > shown.length ? [`… e mais ${tree.length - shown.length}`] : []),
    '```',
  ];
  const readme = ['README.md', 'README', 'readme.md'].map((n) => tryRead(dir, n)).find(Boolean);
  if (readme) parts.push('', '### README', '', readme);
  const claude = tryRead(dir, 'CLAUDE.md');
  if (claude) parts.push('', '### CLAUDE.md', '', claude);
  const pkg = tryRead(dir, 'package.json', 6000);
  if (pkg) parts.push('', '### package.json', '', '```json', pkg, '```');
  return parts.join('\n');
}

export const hasFile = (dir: string, name: string) => existsSync(join(dir, name));
