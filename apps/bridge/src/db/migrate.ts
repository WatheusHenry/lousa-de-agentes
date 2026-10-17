import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/**
 * Aplica as migrações do drizzle sem quebrar quando o banco já tem parte delas.
 *
 * O migrador padrão só compara a data da última migração aplicada. Os agentes do canvas criam
 * migrações em branches paralelos, que depois são renumeradas no merge (com outra data). Quem
 * rodou o bridge num desses branches fica com a tabela criada e, na `main`, o drizzle tenta
 * criar de novo: "table `workspace` already exists", e o bridge não sobe.
 *
 * Aqui a migração é reconhecida pelo conteúdo (o hash que o próprio drizzle grava), e o que já
 * existe é pulado: tabela, índice ou coluna repetidos e INSERT que bateria em chave repetida. As
 * migrações deste projeto só criam coisas, então repetir o resto é seguro. Qualquer outro erro
 * continua parando a subida.
 */
const ALREADY = /already exists|duplicate column name/i;

export function migrateTolerant(sqlite: Database.Database, migrationsFolder: string): { skipped: string[] } {
  const migrations = readMigrationFiles({ migrationsFolder });
  // a mesma tabela de controle do drizzle: bancos antigos e novos continuam compatíveis
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  const applied = new Set(
    (sqlite.prepare('SELECT hash FROM "__drizzle_migrations"').all() as { hash: string }[]).map(
      (r) => r.hash,
    ),
  );
  const record = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  const skipped: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.hash)) continue;
    sqlite.transaction(() => {
      for (const stmt of m.sql) {
        if (!stmt.trim()) continue;
        try {
          sqlite.exec(stmt);
        } catch (err) {
          const msg = (err as Error).message;
          const dupInsert = /^\s*INSERT\b/i.test(stmt) && /UNIQUE constraint failed/i.test(msg);
          if (!ALREADY.test(msg) && !dupInsert) throw err;
          skipped.push(`${stmt.trim().split('\n')[0]!.slice(0, 80)} (${msg})`);
        }
      }
      record.run(m.hash, m.folderMillis);
    })();
  }
  return { skipped };
}
