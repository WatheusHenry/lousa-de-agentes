import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, TOKEN_ENV } from './secrets.ts';

describe('SecretStore', () => {
  it('grava o token num arquivo 0600 fora do banco', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-secrets-'));
    const s = new SecretStore(home, {});
    expect(s.gitlabToken()).toBeNull();
    s.setGitlabToken('glpat-abcdefgh');
    expect(s.gitlabToken()).toEqual({ token: 'glpat-abcdefgh', source: 'secrets-file' });
    const file = join(home, 'secrets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('glpat-abcdefgh');
    s.setGitlabToken(null);
    expect(s.gitlabToken()).toBeNull();
  });

  it('a variável de ambiente tem prioridade', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-secrets-'));
    const s = new SecretStore(home, { [TOKEN_ENV]: 'glpat-from-env' });
    s.setGitlabToken('glpat-from-file');
    expect(s.gitlabToken()).toEqual({ token: 'glpat-from-env', source: 'env' });
  });
});
