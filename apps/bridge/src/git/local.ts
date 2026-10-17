import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { MrDiffFile, RemoteKind } from '@agent-canvas/shared';
import { GitError, parseDiff } from './worktree.ts';

const exec = promisify(execFile);

/**
 * Repositórios locais (fora do GitLab do app): de onde é o remoto, merge no próprio clone e
 * envio do branch com as credenciais git do usuário. Tudo aqui é ação humana, nunca de agente.
 */

/** Sem prompts de senha: com credencial faltando, falha logo em vez de travar o bridge. */
const quietEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
});

async function run(
  cwd: string,
  args: string[],
  timeout = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec('git', args, {
      cwd,
      env: quietEnv(),
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError((e.stderr || e.message).trim().split('\n').slice(-3).join(' '));
  }
}
const git = async (cwd: string, ...args: string[]) => (await run(cwd, args)).stdout;
const tryGit = (cwd: string, ...args: string[]) => git(cwd, ...args).catch(() => null);

/** Pasta do git de um clone (num worktree, `.git` é um arquivo que aponta para ela). */
function gitDir(repo: string): string | null {
  const dotGit = join(repo, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const wt = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(repo, m[1]!.trim());
  const common = join(wt, 'commondir');
  return existsSync(common) ? resolve(wt, readFileSync(common, 'utf8').trim()) : wt;
}

export const isGitRepo = (path: string) => gitDir(path) !== null;

/** URL do remoto `origin` (ou do primeiro remoto), lida do config sem rodar git. */
export function originUrl(repo: string): string | null {
  const dir = gitDir(repo);
  if (!dir) return null;
  let cfg: string;
  try {
    cfg = readFileSync(join(dir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const sections = cfg.split(/^\s*\[/m);
  const urlOf = (sec: string) => /^\s*url\s*=\s*(.+)$/m.exec(sec)?.[1]?.trim() ?? null;
  const origin = sections.find((s) => /^remote\s+"origin"\]/.test(s));
  if (origin) return urlOf(origin);
  const any = sections.find((s) => /^remote\s+"/.test(s));
  return any ? urlOf(any) : null;
}

/** Branch em que o clone está (null se HEAD estiver solto). */
export function currentBranch(repo: string): string | null {
  const dir = gitDir(repo);
  if (!dir) return null;
  // num worktree o HEAD é o do próprio worktree, não o do diretório comum
  const dotGit = join(repo, '.git');
  let headFile = join(dir, 'HEAD');
  if (existsSync(dotGit) && !statSync(dotGit).isDirectory()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (m) headFile = join(isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(repo, m[1]!.trim()), 'HEAD');
  }
  try {
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(headFile, 'utf8'))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Endereço web de um remoto: "git@github.com:acme/app.git" → "https://github.com/acme/app".
 * Credenciais embutidas na URL ("https://user:token@host/…") ficam de fora.
 */
export function remoteWebUrl(url: string): string | null {
  const u = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(u);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const p = new URL(u);
    if (!/^(https?|ssh|git):$/.test(p.protocol)) return null;
    const path = p.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return path ? `https://${p.hostname}/${path}` : null;
  } catch {
    return null;
  }
}

/** GitHub, GitLab (gitlab no nome do host ou a instância configurada no app) ou outro. */
export function remoteKind(url: string | null, gitlabBaseUrl?: string): RemoteKind | null {
  if (!url) return null;
  const web = remoteWebUrl(url);
  if (!web) return 'other';
  const host = new URL(web).hostname.toLowerCase();
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  let gitlabHost: string | null = null;
  try {
    gitlabHost = gitlabBaseUrl ? new URL(gitlabBaseUrl).hostname.toLowerCase() : null;
  } catch {
    /* URL do GitLab inválida: só o nome do host decide */
  }
  if (host === gitlabHost || /(^|\.)gitlab\./.test(host) || host.startsWith('gitlab')) return 'gitlab';
  return 'other';
}

/** Diff de `head` em relação a `base`, rodado no clone (vale mesmo sem o worktree do agente). */
export async function diffBranches(repo: string, base: string, head: string): Promise<MrDiffFile[]> {
  const out = (await tryGit(repo, 'diff', '--no-color', '--no-ext-diff', `${base}...${head}`)) ?? '';
  return parseDiff(out);
}

/** `head` já está contido em `base`? (o merge foi feito, aqui ou pelo terminal) */
export async function isMerged(repo: string, head: string, base: string): Promise<boolean> {
  return (await tryGit(repo, 'merge-base', '--is-ancestor', head, base)) !== null;
}

const branchExists = async (repo: string, b: string) =>
  !!(await tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`));

/** Worktree onde o branch está em uso (o próprio clone ou outro worktree), se estiver. */
async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const out = (await tryGit(repo, 'worktree', 'list', '--porcelain')) ?? '';
  for (const block of out.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (
      path &&
      new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)
    )
      return path;
  }
  return null;
}

/**
 * Merge do branch do agente na base, no clone do usuário. Nunca mexe em mudanças não salvas:
 * se a base estiver aberta com arquivos alterados, recusa e diz o comando. Se a base não estiver
 * aberta em lugar nenhum, faz o merge num worktree temporário (o clone continua onde estava).
 * Em conflito, desfaz o merge e avisa.
 */
export async function mergeLocal(repo: string, branch: string, base: string, message: string): Promise<void> {
  if (!(await branchExists(repo, branch))) throw new GitError(`O branch ${branch} não existe mais no clone.`);
  if (!(await branchExists(repo, base))) throw new GitError(`O branch ${base} não existe no clone.`);
  const manual = `git checkout ${base} && git merge --no-ff ${branch}`;
  const at = await checkedOutAt(repo, base);
  let where = at;
  let temp: string | null = null;
  if (at) {
    const dirty = await git(at, 'status', '--porcelain', '--untracked-files=no');
    if (dirty)
      throw new GitError(
        `${at} está em ${base} com mudanças não salvas. Faça commit ou stash e tente de novo, ou rode: ${manual}`,
      );
  } else {
    temp = mkdtempSync(join(tmpdir(), 'agent-canvas-merge-'));
    rmSync(temp, { recursive: true, force: true });
    await git(repo, 'worktree', 'add', '--quiet', temp, base);
    where = temp;
  }
  try {
    try {
      await git(where!, 'merge', '--no-ff', '--no-edit', '-m', message, branch);
    } catch (err) {
      // o aviso de conflito sai no stdout do git: confere os arquivos não resolvidos
      const conflicted = !!(await tryGit(where!, 'diff', '--name-only', '--diff-filter=U'));
      await tryGit(where!, 'merge', '--abort');
      const msg = (err as Error).message;
      throw new GitError(
        conflicted || /conflict/i.test(msg)
          ? `O merge de ${branch} em ${base} tem conflitos. Peça ao agente para atualizar o branch com ${base}, ou resolva no terminal: ${manual}`
          : `O merge falhou: ${msg}`,
      );
    }
  } finally {
    if (temp) await tryGit(repo, 'worktree', 'remove', '--force', temp);
  }
}

export interface Published {
  /** MR criado no GitLab (lido da saída do push) ou página para abrir o MR/PR. */
  url: string | null;
}

/**
 * Envia o branch ao `origin` com as credenciais git do usuário (chave SSH ou credential helper).
 * No GitLab, as push options já abrem o MR (sem token do app). No GitHub, devolve a página de
 * comparação com o PR preenchido, que o usuário confirma com um clique.
 */
export async function publishBranch(
  repo: string,
  opts: { branch: string; base: string; title: string; body: string; kind: RemoteKind },
): Promise<Published> {
  const remote = originUrl(repo);
  if (!remote) throw new GitError('O repositório não tem remoto: só dá para mergear localmente.');
  const web = remoteWebUrl(remote);
  const args = ['push', '-u', 'origin', `${opts.branch}:${opts.branch}`];
  if (opts.kind === 'gitlab') {
    // valores de push option não podem ter quebra de linha
    const one = (s: string) => s.replace(/\s+/g, ' ').trim();
    args.push(
      '-o',
      'merge_request.create',
      '-o',
      `merge_request.target=${opts.base}`,
      '-o',
      `merge_request.title=${one(opts.title).slice(0, 250)}`,
    );
    if (opts.body.trim()) args.push('-o', `merge_request.description=${one(opts.body).slice(0, 1000)}`);
  }
  let out: { stdout: string; stderr: string };
  try {
    out = await run(repo, args, 5 * 60_000);
  } catch (err) {
    throw new GitError(
      `O push falhou: ${(err as Error).message}. Confira se o git tem acesso ao remoto (chave SSH ou credential helper).`,
    );
  }
  const text = `${out.stdout}\n${out.stderr}`;
  if (opts.kind === 'gitlab') {
    const mr = /https?:\/\/\S+\/-\/merge_requests\/\d+/.exec(text)?.[0];
    if (mr) return { url: mr };
    return {
      url: web
        ? `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(opts.branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(opts.base)}`
        : null,
    };
  }
  if (opts.kind === 'github' && web) {
    const q = new URLSearchParams({
      expand: '1',
      title: opts.title.slice(0, 250),
      body: opts.body.slice(0, 4000),
    });
    return {
      url: `${web}/compare/${encodeURIComponent(opts.base)}...${encodeURIComponent(opts.branch)}?${q}`,
    };
  }
  return { url: null };
}
