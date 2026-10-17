import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateTolerant } from './migrate.ts';

let dir: string;
/** Pasta de migrações no formato do drizzle-kit: cada uma com tag, data e SQL. */
function folder(name: string, list: { tag: string; when: number; sql: string }[]) {
  const f = join(dir, name);
  mkdirSync(join(f, 'meta'), { recursive: true });
  writeFileSync(
    join(f, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: list.map((m, idx) => ({ idx, version: '6', when: m.when, tag: m.tag, breakpoints: true })),
    }),
  );
  for (const m of list) writeFileSync(join(f, `${m.tag}.sql`), m.sql);
  return f;
}
const BASE = { tag: '0000_base', when: 100, sql: 'CREATE TABLE `node` (`id` text PRIMARY KEY NOT NULL);' };
const WS =
  "CREATE TABLE `workspace` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\nALTER TABLE `node` ADD `workspace_id` text;--> statement-breakpoint\nINSERT INTO `workspace` (`id`) VALUES ('default');";

describe('migrações entre branches', () => {
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('migração renomeada no merge (mesmo conteúdo, outra data) não roda de novo', () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-mig-'));
    const branch = folder('branch', [BASE, { tag: '0001_ws', when: 200, sql: WS }]);
    const main = folder('main', [
      BASE,
      { tag: '0001_resize', when: 250, sql: 'ALTER TABLE `node` ADD `w` real;' },
      { tag: '0002_workspaces', when: 300, sql: WS },
    ]);
    const file = join(dir, 'a.db');
    const s1 = new Database(file);
    migrate(drizzle(s1), { migrationsFolder: branch });
    s1.close();
    // o migrador padrão do drizzle quebra aqui (o erro do Windows)
    const s2 = new Database(file);
    expect(() => migrate(drizzle(s2), { migrationsFolder: main })).toThrow();
    s2.close();
    const s = new Database(file);
    expect(migrateTolerant(s, main).skipped).toEqual([]);
    const cols = (s.prepare('pragma table_info(node)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'workspace_id', 'w']);
    expect(migrateTolerant(s, main).skipped).toEqual([]);
    s.close();
  });

  it('migração reescrita no merge: o que já existe é pulado, o resto entra', () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-mig-'));
    const branch = folder('branch', [BASE, { tag: '0001_ws', when: 200, sql: WS }]);
    const main = folder('main', [
      BASE,
      {
        tag: '0001_workspaces',
        when: 300,
        sql: `${WS}--> statement-breakpoint\nALTER TABLE \`node\` ADD \`h\` real;`,
      },
    ]);
    const s = new Database(join(dir, 'b.db'));
    migrateTolerant(s, branch);
    const { skipped } = migrateTolerant(s, main);
    expect(skipped).toHaveLength(3);
    expect(skipped.join('\n')).toMatch(/already exists[\s\S]*duplicate column[\s\S]*UNIQUE/);
    const cols = (s.prepare('pragma table_info(node)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('h');
    // outros erros continuam parando a subida
    const bad = folder('bad', [
      BASE,
      { tag: '0001_bad', when: 400, sql: 'ALTER TABLE `nada` ADD `x` text;' },
    ]);
    expect(() => migrateTolerant(s, bad)).toThrow(/no such table/);
    s.close();
  });
});
