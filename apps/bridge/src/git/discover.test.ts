import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneUrls, matchClone, remotePath, scanClones } from './discover.ts';

function repoAt(path: string, remote?: string) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', path]);
  if (remote) execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
}

describe('descoberta de clones', () => {
  it('normaliza URLs de remoto SSH e HTTPS', () => {
    expect(remotePath('git@gitlab.com:acme/payments-api.git')).toBe('acme/payments-api');
    expect(remotePath('https://gitlab.empresa.com/Acme/Sub/Payments-API.git')).toBe('acme/sub/payments-api');
    expect(remotePath('ssh://git@gitlab.empresa.com:2222/acme/payments-api')).toBe('acme/payments-api');
    expect(remotePath('não é url')).toBeNull();
  });

  it('acha o clone pelo remoto, com qualquer nome de pasta e em subpastas', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-scan-'));
    repoAt(join(root, 'trabalho', 'pagamentos'), 'git@gitlab.com:acme/payments-api.git');
    repoAt(join(root, 'trabalho', 'web-app'));
    repoAt(join(root, 'outro', 'web-app'));
    mkdirSync(join(root, 'node_modules', 'x', '.git'), { recursive: true });
    const clones = scanClones(root);
    expect(clones).toHaveLength(3);
    expect(matchClone(clones, { pathWithNamespace: 'acme/payments-api', name: 'payments-api' })).toBe(
      join(root, 'trabalho', 'pagamentos'),
    );
    // dois clones sem remoto com o mesmo nome: ambíguo, não escolhe
    expect(matchClone(clones, { pathWithNamespace: 'acme/web-app', name: 'web-app' })).toBeNull();
    expect(matchClone(clones, { pathWithNamespace: 'acme/outro', name: 'outro' })).toBeNull();
  });

  it('respeita a profundidade máxima', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-scan-'));
    repoAt(join(root, 'a', 'b', 'c', 'd', 'e', 'fundo'), 'git@x:g/fundo.git');
    expect(scanClones(root, 4)).toHaveLength(0);
    expect(scanClones(root, 6)).toHaveLength(1);
  });

  it('URLs de clone a partir da página do projeto', () => {
    expect(cloneUrls('https://gitlab.com/acme/payments-api')).toEqual([
      'git@gitlab.com:acme/payments-api.git',
      'https://gitlab.com/acme/payments-api.git',
    ]);
  });
});
