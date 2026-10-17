import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeLoginState } from '@agent-canvas/shared';
import { ClaudeLogin } from './claude-login.ts';

let dir: string;
const fake = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
async function until(get: () => ClaudeLoginState, ok: (s: ClaudeLoginState) => boolean) {
  for (let i = 0; i < 200; i++) {
    if (ok(get())) return get();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`estado: ${JSON.stringify(get())}`);
}

describe('login do Claude Code pelo canvas', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-login-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mostra a página de login, recebe o código colado e termina', async () => {
    // imita `claude auth login`: mostra a URL, espera o código e sai com 0
    const bin = fake(
      'claude-ok',
      `if (process.argv.slice(2).join(' ') !== 'auth login') process.exit(2);
console.log('Opening browser to sign in…');
console.log('If the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&state=abc');
process.stdout.write('Paste code here if prompted > ');
process.stdin.once('data', (d) => process.exit(String(d).trim() === 'codigo-123' ? 0 : 1));`,
    );
    const seen: ClaudeLoginState[] = [];
    const login = new ClaudeLogin((s) => seen.push(s), bin);
    expect(login.start().state).toBe('waiting');
    const w = await until(
      () => login.state(),
      (s) => !!s.url,
    );
    expect(w.url).toBe('https://claude.ai/oauth/authorize?code=true&state=abc');
    // um segundo clique não abre outro login
    expect(login.start()).toBe(login.state());
    login.code('  codigo-123 ');
    const done = await until(
      () => login.state(),
      (s) => s.state !== 'waiting',
    );
    expect(done).toMatchObject({ state: 'done', url: null });
    expect(seen.map((s) => s.state)).toContain('waiting');
  });

  it('falha com o motivo; comando ausente e cancelar', async () => {
    const bad = fake('claude-bad', `console.error('Login cancelled by user'); process.exit(1);`);
    const login = new ClaudeLogin(() => {}, bad);
    login.start();
    const f = await until(
      () => login.state(),
      (s) => s.state === 'failed',
    );
    expect(f.message).toContain('Login cancelled by user');

    const missing = new ClaudeLogin(() => {}, join(dir, 'nao-existe'));
    missing.start();
    expect(
      (
        await until(
          () => missing.state(),
          (s) => s.state === 'failed',
        )
      ).message,
    ).toContain('Não encontrei o comando');

    const slow = new ClaudeLogin(() => {}, fake('claude-slow', 'setTimeout(() => {}, 60_000);'));
    slow.start();
    slow.cancel();
    expect(slow.state()).toEqual({ state: 'idle', url: null, message: null });
    expect(() => slow.code('x')).toThrow('Nenhum login');
  });

  it('desiste depois do tempo limite', async () => {
    const login = new ClaudeLogin(() => {}, fake('claude-hang', 'setTimeout(() => {}, 60_000);'), 50);
    login.start();
    const f = await until(
      () => login.state(),
      (s) => s.state === 'failed',
    );
    expect(f.message).toContain('cancelado');
  });
});
