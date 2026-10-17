import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitsSince, conflictNotice, createWorktree, mergeConflicts, slugify } from './worktree.ts';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wt-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'inicial');
  return { dir, git };
}

describe('worktree', () => {
  it('slugify', () => {
    expect(slugify('Webhook de pagamento duplica cobrança quando o gateway reenvia')).toBe(
      'webhook-pagamento-duplica-cobranca',
    );
    expect(slugify('!!')).toBe('tarefa');
  });

  it('cria worktree num branch novo, sem rede, e esconde .agent-canvas dos commits', async () => {
    const { dir } = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'ac-wt-root-'));
    const wt = await createWorktree({
      repoPath: dir,
      root,
      agentId: 'a1',
      branchName: 'agent/142-x',
      defaultBranch: 'main',
    });
    expect(wt.branch).toBe('agent/142-x');
    expect(wt.base).toBe('main');
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.agent-canvas/');

    // .agent-canvas não aparece no status; um commit novo aparece em commitsSince
    const g = (...a: string[]) => execFileSync('git', a, { cwd: wt.path, stdio: 'pipe' }).toString().trim();
    execFileSync('mkdir', ['-p', join(wt.path, '.agent-canvas')]);
    writeFileSync(join(wt.path, '.agent-canvas', 'context.md'), 'x');
    expect(g('status', '--porcelain')).toBe('');
    writeFileSync(join(wt.path, 'b.txt'), 'b\n');
    g('add', '.');
    g('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'b');
    expect(await commitsSince(wt.path, wt.base)).toHaveLength(1);

    // mesmo nome de branch de novo: ganha sufixo
    const wt2 = await createWorktree({
      repoPath: dir,
      root,
      agentId: 'a2',
      branchName: 'agent/142-x',
      defaultBranch: 'main',
    });
    expect(wt2.branch).toBe('agent/142-x-2');
  });

  it('erro claro quando a pasta não é um repositório', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'ac-wt-no-'));
    await expect(
      createWorktree({
        repoPath: notRepo,
        root: notRepo,
        agentId: 'a',
        branchName: 'b',
        defaultBranch: null,
      }),
    ).rejects.toThrow(/não é um repositório/);
  });

  it('mergeConflicts acha os arquivos em conflito com a base sem tocar no worktree', async () => {
    const { dir, git } = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'ac-wt-root-'));
    const wt = await createWorktree({
      repoPath: dir,
      root,
      agentId: 'a1',
      branchName: 'agent/1-conflito',
      defaultBranch: 'main',
    });
    const g = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...a], {
        cwd: wt.path,
        stdio: 'pipe',
      })
        .toString()
        .trim();
    writeFileSync(join(wt.path, 'a.txt'), 'do agente\n');
    writeFileSync(join(wt.path, 'novo.txt'), 'n\n');
    g('commit', '-qam', 'agente');
    g('add', '.');
    g('commit', '-qm', 'novo');
    expect(await mergeConflicts(wt.path, 'main', { local: true })).toEqual({ base: 'main', files: [] });

    // outra mudança entra na base no mesmo arquivo
    writeFileSync(join(dir, 'a.txt'), 'da base\n');
    git('commit', '-qam', 'base');
    const c = await mergeConflicts(wt.path, 'main', { local: true });
    expect(c).toEqual({ base: 'main', files: ['a.txt'] });
    expect(g('status', '--porcelain')).toBe('');
    expect(conflictNotice(c!, 'Nada foi enviado.')).toMatch(/a\.txt[\s\S]*git merge main/);

    // resolvido no branch: volta a entrar limpo
    expect(() => g('merge', '-q', 'main')).toThrow();
    writeFileSync(join(wt.path, 'a.txt'), 'da base\ndo agente\n');
    g('commit', '-qam', 'merge da base');
    expect(await mergeConflicts(wt.path, 'main', { local: true })).toEqual({ base: 'main', files: [] });
    expect(await mergeConflicts(wt.path, 'nao-existe')).toBeNull();
  });
});
