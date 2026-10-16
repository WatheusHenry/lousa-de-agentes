import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GitError } from './worktree.ts';

const exec = promisify(execFile);

export interface LocalClone {
  path: string;
  /** Caminhos dos remotos normalizados: "grupo/sub/projeto", em minúsculas. */
  remotes: string[];
}

/** Pastas que nunca têm clones dentro e custam caro para percorrer. */
const SKIP = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'snap',
  'Library',
  'Applications',
  '__pycache__',
  'venv',
]);

/**
 * "git@gitlab.com:acme/payments-api.git", "https://gitlab.com/acme/payments-api.git" ou
 * "ssh://git@host:2222/acme/payments-api" → "acme/payments-api".
 */
export function remotePath(url: string): string | null {
  const u = url.trim();
  let path: string | undefined;
  const scp = /^[\w.-]+@[\w.-]+:(?!\/)(.+)$/.exec(u);
  if (scp) path = scp[1];
  else {
    try {
      path = new URL(u).pathname;
    } catch {
      return null;
    }
  }
  const clean = path!
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .toLowerCase();
  return clean || null;
}

/** URLs dos remotos lidas direto do `.git/config` (sem rodar git: a busca fica rápida). */
function readRemotes(repo: string): string[] {
  try {
    const cfg = readFileSync(join(repo, '.git', 'config'), 'utf8');
    return [...cfg.matchAll(/^\s*url\s*=\s*(.+)$/gm)]
      .map((m) => remotePath(m[1]!))
      .filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/**
 * Procura clones git até `maxDepth` níveis abaixo de `root`. Não entra em pastas ocultas, em
 * dependências nem dentro de um clone já achado.
 */
export function scanClones(root: string, maxDepth = 4, maxDirs = 20_000): LocalClone[] {
  const found: LocalClone[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (visited++ > maxDirs) return;
    if (existsSync(join(dir, '.git'))) {
      found.push({ path: dir, remotes: readRemotes(dir) });
      return;
    }
    if (depth >= maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root, 0);
  return found;
}

/**
 * O clone de um projeto: primeiro pelo remoto (o nome da pasta pode ser qualquer um); se nenhum
 * remoto bater, por nome de pasta igual ao do projeto, desde que só um clone tenha esse nome.
 */
export function matchClone(
  clones: LocalClone[],
  project: { pathWithNamespace: string; name: string },
): string | null {
  const want = project.pathWithNamespace.toLowerCase();
  const byRemote = clones.filter((c) => c.remotes.includes(want));
  if (byRemote.length) return byRemote.sort((a, b) => a.path.length - b.path.length)[0]!.path;
  const byName = clones.filter((c) => basename(c.path).toLowerCase() === project.name.toLowerCase());
  return byName.length === 1 ? byName[0]!.path : null;
}

/** O caminho informado é de outro projeto? (tem remotos e nenhum aponta para este) */
export function cloneOfOtherProject(path: string, pathWithNamespace: string): boolean {
  const remotes = readRemotes(path);
  return remotes.length > 0 && !remotes.includes(pathWithNamespace.toLowerCase());
}

/**
 * Clona com as credenciais git do próprio usuário (chave SSH ou credential helper). Nunca usa o
 * token do GitLab, que gravaria o segredo no `.git/config`. Sem prompts: falha logo se precisar.
 */
export async function cloneRepo(urls: string[], dest: string): Promise<string> {
  if (existsSync(dest)) throw new GitError(`A pasta ${dest} já existe.`);
  mkdirSync(dirname(dest), { recursive: true });
  const errors: string[] = [];
  for (const url of urls) {
    try {
      await exec('git', ['clone', '--quiet', url, dest], {
        timeout: 15 * 60_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        },
      });
      return url;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const lines = (e.stderr || e.message).split('\n').map((l) => l.trim());
      const reason =
        lines.find((l) => /denied|fatal|could not|not found|timed out/i.test(l)) ?? lines.find(Boolean);
      errors.push(`${url}: ${reason}`);
    }
  }
  throw new GitError(
    `Não consegui clonar (${errors.join(' · ')}). Cadastre uma chave SSH no GitLab ou configure um credential helper para HTTPS; ou clone pelo terminal e clique em Procurar de novo.`,
  );
}

/** URLs prováveis de clone a partir da página do projeto: SSH primeiro, depois HTTPS. */
export function cloneUrls(webUrl: string): string[] {
  try {
    const u = new URL(webUrl);
    const path = u.pathname.replace(/^\/+|\/+$/g, '');
    return [`git@${u.hostname}:${path}.git`, `${u.origin}/${path}.git`];
  } catch {
    return [];
  }
}
