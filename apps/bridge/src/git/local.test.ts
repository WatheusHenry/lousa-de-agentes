import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentBranch,
  diffBranches,
  isMerged,
  mergeLocal,
  originUrl,
  publishBranch,
  remoteKind,
  remoteWebUrl,
} from './local.ts';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

describe('remoto de um repositório local', () => {
  it('endereço web e tipo a partir da URL do remoto', () => {
    expect(remoteWebUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(remoteWebUrl('https://gitlab.com/acme/sub/app.git')).toBe('https://gitlab.com/acme/sub/app');
    expect(remoteWebUrl('ssh://git@git.acme.io:2222/acme/app')).toBe('https://git.acme.io/acme/app');
    // credenciais na URL não vão para o link
    expect(remoteWebUrl('https://user:segredo@github.com/acme/app.git')).toBe('https://github.com/acme/app');
    expect(remoteKind('git@github.com:acme/app.git')).toBe('github');
    expect(remoteKind('git@gitlab.com:acme/app.git')).toBe('gitlab');
    expect(remoteKind('https://gitlab.acme.io/acme/app.git')).toBe('gitlab');
    // instância própria do GitLab com outro nome: reconhecida pela URL configurada no app
    expect(remoteKind('git@git.acme.io:acme/app.git', 'https://git.acme.io')).toBe('gitlab');
    expect(remoteKind('git@git.acme.io:acme/app.git')).toBe('other');
    expect(remoteKind(null)).toBeNull();
  });
});

// muitos processos git por teste: com a suíte inteira rodando em paralelo, 5 s pode não bastar
describe('merge e envio de um repositório local', { timeout: 20_000 }, () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-local-'));
    repo = join(dir, 'app');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'um\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'inicial');
    // branch do agente com um commit
    git(repo, 'branch', 'agent/x');
    git(repo, 'worktree', 'add', '-q', join(dir, 'wt'), 'agent/x');
    writeFileSync(join(dir, 'wt', 'b.txt'), 'novo\n');
    git(join(dir, 'wt'), 'add', '.');
    git(join(dir, 'wt'), 'commit', '-qm', 'agente');
    process.env.GIT_AUTHOR_NAME = 'T';
    process.env.GIT_AUTHOR_EMAIL = 't@e.com';
    process.env.GIT_COMMITTER_NAME = 'T';
    process.env.GIT_COMMITTER_EMAIL = 't@e.com';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lê branch atual e remoto direto do .git', () => {
    expect(currentBranch(repo)).toBe('main');
    expect(currentBranch(join(dir, 'wt'))).toBe('agent/x');
    expect(originUrl(repo)).toBeNull();
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    expect(originUrl(repo)).toBe('git@github.com:acme/app.git');
    expect(originUrl(join(dir, 'wt'))).toBe('git@github.com:acme/app.git');
  });

  it('com a base aberta e limpa, faz o merge ali; com mudanças não salvas, recusa sem mexer', async () => {
    expect(await diffBranches(repo, 'main', 'agent/x')).toHaveLength(1);
    writeFileSync(join(repo, 'a.txt'), 'meu trabalho\n');
    await expect(mergeLocal(repo, 'agent/x', 'main', 'Merge')).rejects.toThrow(/mudanças não salvas/);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('meu trabalho\n');
    expect(await isMerged(repo, 'agent/x', 'main')).toBe(false);
    git(repo, 'checkout', '-q', '--', 'a.txt');
    await mergeLocal(repo, 'agent/x', 'main', 'Merge do agente');
    expect(await isMerged(repo, 'agent/x', 'main')).toBe(true);
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('novo\n');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge do agente');
  });

  it('com o clone em outro branch, faz o merge num worktree temporário e não troca o branch', async () => {
    git(repo, 'checkout', '-q', '-b', 'minha-feature');
    writeFileSync(join(repo, 'rascunho.txt'), 'não salvo\n');
    await mergeLocal(repo, 'agent/x', 'main', 'Merge');
    expect(currentBranch(repo)).toBe('minha-feature');
    expect(readFileSync(join(repo, 'rascunho.txt'), 'utf8')).toBe('não salvo\n');
    expect(await isMerged(repo, 'agent/x', 'main')).toBe(true);
    // o worktree temporário foi embora
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(2);
  });

  it('em conflito, desfaz o merge e explica', async () => {
    writeFileSync(join(dir, 'wt', 'a.txt'), 'do agente\n');
    git(join(dir, 'wt'), 'commit', '-qam', 'muda a');
    writeFileSync(join(repo, 'a.txt'), 'do usuário\n');
    git(repo, 'commit', '-qam', 'muda a também');
    await expect(mergeLocal(repo, 'agent/x', 'main', 'Merge')).rejects.toThrow(/conflitos/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('do usuário\n');
  });

  it('envia ao GitHub e devolve a página do PR; no GitLab, usa push options', async () => {
    const bare = join(dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    // o remoto "é" do GitHub, mas o push vai para a pasta (insteadOf)
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
    const gh = await publishBranch(repo, {
      branch: 'agent/x',
      base: 'main',
      title: 'Adiciona b',
      body: 'Detalhes',
      kind: 'github',
    });
    expect(gh.url).toMatch(
      /^https:\/\/github\.com\/acme\/app\/compare\/main\.\.\.agent%2Fx\?expand=1&title=Adiciona\+b/,
    );
    expect(git(bare, 'branch', '--list', 'agent/x')).toContain('agent/x');

    git(bare, 'config', 'receive.advertisePushOptions', 'true');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
    git(repo, 'config', `url.${bare}.insteadOf`, 'https://gitlab.com/acme/app.git');
    const gl = await publishBranch(repo, {
      branch: 'agent/x',
      base: 'main',
      title: 'Adiciona b',
      body: 'linha 1\nlinha 2',
      kind: 'gitlab',
    });
    // sem o GitLab de verdade respondendo com o link, cai na página de criar o MR
    expect(gl.url).toBe(
      'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=agent%2Fx&merge_request%5Btarget_branch%5D=main',
    );
  });

  it('sem remoto, não há para onde enviar', async () => {
    await expect(
      publishBranch(repo, { branch: 'agent/x', base: 'main', title: 't', body: '', kind: 'other' }),
    ).rejects.toThrow(/não tem remoto/);
  });
});
