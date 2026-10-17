import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import { migrateTolerant } from './migrate.ts';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Abre (ou cria) o banco e aplica as migrações. Use ':memory:' nos testes. */
export function openDb(file: string): { db: Db; sqlite: Database.Database; close: () => void } {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  const { skipped } = migrateTolerant(sqlite, migrationsFolder);
  if (skipped.length)
    console.warn(
      `[agent-canvas] Migrações que o banco já tinha (de outro branch), puladas:\n  ${skipped.join('\n  ')}`,
    );
  return { db, sqlite, close: () => sqlite.close() };
}

export { schema };
