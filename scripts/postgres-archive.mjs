import { spawn } from 'node:child_process';
import { mkdtemp, rm, unlink, link, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { decryptArchive, encryptArchive, postgresHeader } from './encrypted-archive.mjs';

const diagnostics = [
  [/could not open .*file/i, 'archive or catalog file could not be opened'],
  [/invalid archive|not .*valid archive|unsupported version|invalid TOC/i, 'archive or catalog format rejected'],
  [/input file is too short|unexpected end of file/i, 'archive content is incomplete'],
  [/already exists/i, 'database object already exists'],
  [/permission denied|must be owner/i, 'database or file permission denied'],
  [/authentication failed|connection .* failed|could not connect/i, 'database connection failed'],
  [/unrecognized configuration parameter/i, 'client and server settings are incompatible'],
  [/could not execute query/i, 'database rejected a restore command'],
];

function toolEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG/i.test(name) && !/^PROJECTOS_/i.test(name))),
    LC_ALL: 'C',
  };
}

function connection(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.pathname.slice(1)) {
    throw new Error('Invalid PostgreSQL connection configuration');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return {
    url, loopback,
    database: decodeURIComponent(url.pathname.slice(1)),
    env: {
      ...toolEnvironment(),
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGSSLMODE: loopback ? 'disable' : 'verify-full',
      ...(process.env.PGSSLROOTCERT ? { PGSSLROOTCERT: process.env.PGSSLROOTCERT } : {}),
      PGCONNECT_TIMEOUT: '5',
    },
  };
}

function run(program, args, env = toolEnvironment()) {
  const bin = process.env.PROJECTOS_PG_BIN ? join(process.env.PROJECTOS_PG_BIN, program) : program;
  const operation = program === 'pg_dump' ? 'PostgreSQL dump' : args.includes('--list') ? 'PostgreSQL restore catalog' : 'PostgreSQL restore';
  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr = (stderr + chunk.toString()).slice(0, 4096); });
  const completion = new Promise((ok, fail) => {
    child.once('error', () => fail(new Error(operation + ' could not start')));
    child.once('close', (code, signal) => {
      if (code === 0) { ok(); return; }
      // pg_restore may print the offending SQL and its data. Return a fixed diagnostic only.
      const reason = diagnostics.find(([pattern]) => pattern.test(stderr))?.[1];
      fail(new Error(operation + ' failed (' + (signal ?? 'exit ' + code) + (reason ? ', ' + reason : '') + ')'));
    });
  });
  // Attach immediately because dump/encryption and subprocess exit are asynchronous.
  completion.catch(() => {});
  return { child, completion };
}

export async function backupPostgres(destination, connectionString, passphrase) {
  const config = connection(connectionString);
  if (!destination.endsWith('.posbak')) throw new Error('Expected a .posbak file');
  const finalPath = resolve(destination);
  const {randomUUID} = await import('node:crypto');
  const temporary = join(dirname(finalPath), '.' + basename(finalPath) + '.' + randomUUID() + '.part');
  const { child, completion } = run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges',
    '--schema=public', '--schema=projectos_private', '--extension=pgcrypto',
    '--exclude-table-data=projectos_private.scope_key',
    '--exclude-table-data=projectos_private.monitor_logins',
    '--exclude-table-data=projectos_private.reminder_logins'], config.env);
  // Attach immediately so a short-lived pg_dump cannot exit before Node observes its stdout.
  const buffered=new PassThrough();
  const consumed=pipeline(child.stdout,buffered);
  consumed.catch(()=>{});
  try {
    const bytes=await encryptArchive(buffered, temporary, passphrase, postgresHeader);
    await Promise.all([completion,consumed]);
    if (bytes===0) throw new Error('PostgreSQL dump returned no archive');
    // Atomic publication, including refusal to overwrite an existing backup.
    await link(temporary, finalPath);
    return { ok: true, format: 'PROJECTOS-POSTGRES-v1', encrypted: true, streaming: true };
  } finally {
    buffered.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled([completion,consumed]);
    await unlink(temporary).catch(() => {});
  }
}

async function readCatalog(file) {
  const {child,completion}=run('pg_restore',['--list',file]);
  let catalog='';
  try {
    for await (const chunk of child.stdout) {
      catalog+=chunk.toString('utf8');
      if (catalog.length>8*1024*1024) throw new Error('Restore catalog exceeds expected bounds');
    }
    await completion;
    return catalog;
  } finally {
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await completion.catch(()=>{});
  }
}

export async function verifyPostgresBackup(source,passphrase) {
  const scratch=await mkdtemp(join(tmpdir(),'projectos-verify-pg-'));
  const file=join(scratch,'archive.dump');
  try {
    await decryptArchive(resolve(source),file,passphrase,postgresHeader);
    const catalog=await readCatalog(file);
    for (const table of ['workspaces','users','memberships','records','document_versions']) {
      if (!new RegExp('^\\d+;\\s+\\d+\\s+\\d+\\s+TABLE DATA public '+table+'\\s','m').test(catalog)) {
        throw new Error('PostgreSQL archive is missing a required ProjectOS table');
      }
    }
    // SQL is generated only to verify data decoding. No database connection is used.
    const {child,completion}=run('pg_restore',['--file='+devNull,file]);
    child.stdout.resume();
    await completion;
    return {ok:true,format:'PROJECTOS-POSTGRES-v1',encrypted:true,catalogVerified:true,dataDecoded:true};
  } finally {
    await rm(scratch,{recursive:true,force:true,maxRetries:5});
  }
}

export async function restorePostgres(source, restoreUrl, passphrase) {
  const config = connection(restoreUrl);
  if (process.env.PROJECTOS_DATABASE_URL) {
    const active = connection(process.env.PROJECTOS_DATABASE_URL);
    if (config.url.hostname === active.url.hostname && config.env.PGPORT === active.env.PGPORT && config.database === active.database) {
      throw new Error('Restore target cannot be the active database');
    }
  }
  if (!/^projectos_restore_[a-z0-9_]{1,40}$/.test(config.database)) throw new Error('Restore to a dedicated projectos_restore_* database');
  const scratch = await mkdtemp(join(tmpdir(), 'projectos-restore-pg-'));
  const data = join(scratch, 'archive.dump');
  const client = new pg.Client({
    connectionString: restoreUrl, ssl: config.loopback ? false : { rejectUnauthorized: true, ca: process.env.PROJECTOS_PG_CA || undefined },
    connectionTimeoutMillis: 5_000,
  });
  try {
    await decryptArchive(resolve(source), data, passphrase, postgresHeader);
    await client.connect();
    await client.query('SELECT pg_advisory_lock(3804523)');
    const present = await client.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1`);
    if (present.rowCount) throw new Error('Restore database must be empty');
    const toc = await readCatalog(data);
    // A newly created database already contains public. Leave that namespace in place.
    const listPath = join(scratch, 'restore.list');
    const filtered = toc.split(/\r?\n/).filter(line => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public\s/.test(line));
    await writeFile(listPath, filtered.join('\n'), { flag: 'wx', mode: 0o600 });
    const { child, completion } = run('pg_restore', [
      '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--use-list=' + listPath,
      '--dbname=' + config.database, data,
    ], config.env);
    child.stdout.resume();
    await completion;
    const verified = (await client.query(`SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces,
      (SELECT COUNT(*) FROM records) AS records, (SELECT COUNT(*) FROM document_versions) AS document_versions`)).rows[0];
    return { ok: true, restore: 'isolated-postgresql', ...verified };
  } finally {
    await client.end().catch(() => {});
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
