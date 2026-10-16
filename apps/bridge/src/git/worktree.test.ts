import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitsSince, createWorktree, slugify } from './worktree.ts';

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
});
