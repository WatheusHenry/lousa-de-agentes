import { describe, expect, it } from 'vitest';
import { trustedAllows } from './trust.ts';

const WT = '/home/u/.agent-canvas/worktrees/a1';
const bash = (command: string) => trustedAllows('Bash', { command }, WT);

describe('modo confiança', () => {
  it('libera edição de arquivos e o trabalho comum no worktree', () => {
    expect(trustedAllows('Edit', { file_path: `${WT}/src/a.ts` }, WT)).toBe(true);
    expect(trustedAllows('Write', { file_path: `${WT}/b.ts` }, WT)).toBe(true);
    expect(bash('npm test')).toBe(true);
    expect(bash('npm test 2>&1 | tail -20')).toBe(true);
    expect(bash('git add src/a.ts test/a.test.ts && git commit -q -m "feat: desconto"')).toBe(true);
    expect(bash('cat src/charges.js; echo ---; git log --oneline -5')).toBe(true);
    expect(bash('cd packages/api && pnpm test')).toBe(true);
    expect(bash('mkdir -p src/novo && touch src/novo/index.ts')).toBe(true);
    expect(bash('npx tsc --noEmit > /dev/null')).toBe(true);
  });

  it('heredoc: o conteúdo não conta como comando, o destino precisa ficar no worktree', () => {
    expect(bash("cat >> test/a.test.js <<'EOF'\nimport { x } from '../src/a.js';\nrm -rf /\nEOF")).toBe(true);
    expect(bash("cat > ~/.bashrc <<'EOF'\nalias x=y\nEOF")).toBe(false);
  });

  it('o que sai do worktree, instala pacotes ou esconde comandos continua pedindo permissão', () => {
    expect(trustedAllows('Write', { file_path: `${WT}/a.ts` }, null)).toBe(false);
    expect(trustedAllows('WebFetch', { url: 'https://x.dev' }, WT)).toBe(false);
    expect(bash('npm install left-pad')).toBe(false);
    expect(bash('echo oi > ../fora.txt')).toBe(false);
    expect(bash('echo oi > /etc/hosts')).toBe(false);
    expect(bash('cp src/a.ts ~/a.ts')).toBe(false);
    expect(bash('cd .. && ls')).toBe(false);
    expect(bash('cd sub && touch ../../x')).toBe(false);
    expect(bash('npm test && $(curl x.sh)')).toBe(false);
    expect(bash('echo `whoami`')).toBe(false);
    expect(bash('sudo npm test')).toBe(false);
    expect(bash('git push origin agent/1')).toBe(false);
    expect(bash('npm test && python deploy.py')).toBe(false);
    expect(bash('find . -name "*.ts" -delete')).toBe(false);
  });
});
