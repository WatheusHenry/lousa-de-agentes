import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { MrDiffFile } from '@agent-canvas/shared';

const exec = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError((e.stderr || e.message).trim().split('\n').slice(-3).join(' '));
  }
}

const tryGit = (cwd: string, ...args: string[]) => git(cwd, ...args).catch(() => null);

/** "Webhook duplica cobrança quando…" → "webhook-duplica-cobranca" */
export function slugify(s: string, words = 4): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2)
    .slice(0, words)
    .join('-');
  return slug || 'tarefa';
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

/**
 * Cria um worktree para o agente em `<root>/<agentId>` num branch novo a partir do branch
 * padrão do projeto (de origin, se der para buscar). Agentes em paralelo não se pisam.
 */
export async function createWorktree(opts: {
  repoPath: string;
  root: string;
  agentId: string;
  branchName: string;
  defaultBranch: string | null;
  /** A base é um branch local (o do agente pai): sem fetch e sem preferir origin/. */
  localBase?: boolean;
}): Promise<Worktree> {
  const { repoPath, root, agentId } = opts;
  if (!existsSync(join(repoPath, '.git'))) throw new GitError(`${repoPath} não é um repositório git.`);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  if (existsSync(path)) throw new GitError(`O worktree ${path} já existe.`);

  const def = opts.defaultBranch || (await tryGit(repoPath, 'symbolic-ref', '--short', 'HEAD')) || 'main';
  // tenta atualizar o branch padrão; sem rede, usa o que houver localmente
  if (!opts.localBase) await tryGit(repoPath, 'fetch', '--quiet', 'origin', def);
  let base = def;
  for (const candidate of opts.localBase ? [def] : [`origin/${def}`, def, 'HEAD']) {
    if (await tryGit(repoPath, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`)) {
      base = candidate;
      break;
    }
  }

  let branch = opts.branchName;
  for (let n = 2; await tryGit(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); n++)
    branch = `${opts.branchName}-${n}`;

  await git(repoPath, 'worktree', 'add', '--quiet', '-b', branch, path, base);
  excludeCanvasDir(path);
  return { path, branch, base };
}

/** `.agent-canvas/` (contexto e config do agente) nunca entra em commits. */
export function excludeCanvasDir(worktree: string): void {
  const gitFile = join(worktree, '.git');
  let gitDir = gitFile;
  if (existsSync(gitFile) && !existsSync(join(gitFile, 'HEAD'))) {
    // num worktree, .git é um arquivo "gitdir: <caminho>"; o exclude fica no diretório comum
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, 'utf8'));
    if (m) {
      const wtGitDir = isAbsolute(m[1]!) ? m[1]! : resolve(worktree, m[1]!);
      const common = join(wtGitDir, 'commondir');
      gitDir = existsSync(common) ? resolve(wtGitDir, readFileSync(common, 'utf8').trim()) : wtGitDir;
    }
  }
  const exclude = join(gitDir, 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.agent-canvas/'))
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.agent-canvas/\n`);
}

/** Commits do worktree que não estão na base. */
export async function commitsSince(worktree: string, base: string): Promise<string[]> {
  const out = await tryGit(worktree, 'log', '--oneline', `${base}..HEAD`);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Envia o branch do worktree para o remoto `origin`, com as credenciais git do usuário. */
export async function pushBranch(worktree: string, branch: string): Promise<void> {
  await git(worktree, 'push', '--quiet', '-u', 'origin', `${branch}:${branch}`);
}

/** Diff do branch atual em relação à base, separado por arquivo (para quando o GitLab não traz). */
export async function localDiff(worktree: string, base: string): Promise<MrDiffFile[]> {
  let ref = base;
  for (const candidate of [`origin/${base}`, base]) {
    if (await tryGit(worktree, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`)) {
      ref = candidate;
      break;
    }
  }
  const out = (await tryGit(worktree, 'diff', '--no-color', '--no-ext-diff', `${ref}...HEAD`)) ?? '';
  return parseDiff(out);
}

/** Saída do `git diff` separada por arquivo. */
export function parseDiff(out: string): MrDiffFile[] {
  const files: MrDiffFile[] = [];
  for (const block of out.split(/^diff --git /m).slice(1)) {
    const lines = block.split('\n');
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? '');
    const hunk = lines.findIndex((l) => l.startsWith('@@'));
    files.push({
      oldPath: m?.[1] ?? '',
      newPath: m?.[2] ?? '',
      diff: hunk >= 0 ? lines.slice(hunk).join('\n') + '\n' : '',
      newFile: lines.some((l) => l.startsWith('new file mode')),
      deletedFile: lines.some((l) => l.startsWith('deleted file mode')),
      renamedFile: lines.some((l) => l.startsWith('rename from')),
    });
  }
  return files;
}
