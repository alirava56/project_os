import { closeDatabase, sql } from './database.mjs';

try {
  const key = process.env.PROJECTOS_DB_SCOPE_KEY;
  if (sql.dialect !== 'postgres' || !/^[a-f0-9]{64}$/i.test(key ?? '')) {
    throw new Error('PostgreSQL and a 32-byte hex scope key are required');
  }
  await sql.run(`INSERT INTO projectos_private.scope_key(singleton,secret) VALUES(true,decode(?,'hex'))
    ON CONFLICT (singleton) DO UPDATE SET secret=excluded.secret`, key);
  console.log('Database scope signing key provisioned');
} catch {
  console.error('Database scope provisioning failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
