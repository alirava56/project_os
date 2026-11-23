#!/usr/bin/env node
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configuredChannels } from './notification-providers.mjs';

const env = process.env;
const abort = new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => abort.abort());
if (process.connected) process.on('message',message => { if (message === 'stop') abort.abort(); });

function localDatabase(value) {
  const url = new URL(value);
  if (!['postgres:','postgresql:'].includes(url.protocol)
    || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.search || url.hash || !url.username) {
    throw new Error('A dedicated loopback PostgreSQL connection is required');
  }
  return url;
}

function run(script, databaseUrl) {
  return new Promise(resolve => {
    const child = fork(fileURLToPath(new URL(script,import.meta.url)),[],{
      env:{...env,PROJECTOS_DATABASE_URL:databaseUrl,PROJECTOS_DATABASE_MODE:'postgres'},stdio:['ignore','inherit','inherit','ipc'],
    });
    const stop = () => { if (child.connected) child.send('stop',() => {}); };
    abort.signal.addEventListener('abort',stop,{once:true});
    child.once('error',() => { console.error('Unable to start local worker'); });
    child.once('close',code => {
      abort.signal.removeEventListener('abort',stop);
      resolve(code === 0);
    });
  });
}

try {
  const reminder = localDatabase(env.PROJECTOS_LOCAL_REMINDER_DATABASE_URL);
  const channels = configuredChannels(env);
  const delivery = Object.keys(channels).length ? localDatabase(env.PROJECTOS_LOCAL_DELIVERY_DATABASE_URL) : undefined;
  if ((env.PROJECTOS_TELEGRAM_NOTIFICATIONS === 'enabled' && !channels.telegram)
    || (env.PROJECTOS_EMAIL_NOTIFICATIONS === 'enabled' && !channels.email)) {
    throw new Error('Invalid credentials or recipient configuration');
  }
  if (delivery && (delivery.hostname!==reminder.hostname || delivery.port!==reminder.port
    || delivery.pathname!==reminder.pathname || decodeURIComponent(delivery.username)===decodeURIComponent(reminder.username))) {
    throw new Error('Use two worker logins for the same database');
  }
  const interval = Number(env.PROJECTOS_LOCAL_WORKER_INTERVAL_MS ?? '30000');
  if (!env.PROJECTOS_NOTIFICATION_WORKSPACE || !Number.isSafeInteger(interval) || interval < 5000 || interval > 300000) {
    throw new Error('A workspace and a polling interval between 5000 and 300000 are required');
  }
  while (!abort.signal.aborted) {
    const scanned = await run('./run-reminders.mjs',reminder.href);
    const sent = !delivery || abort.signal.aborted || (scanned && await run('./deliver-notifications.mjs',delivery.href));
    console.log(JSON.stringify({workerStatus:scanned && sent ? 'ready' : 'degraded',delivery:delivery ? 'configured' : 'not_configured'}));
    await delay(interval,undefined,{signal:abort.signal});
  }
} catch (error) {
  if (!abort.signal.aborted) {
    console.error('Local worker configuration failed:',error.name);
    process.exitCode = 1;
  }
} finally {
  if (process.connected) process.disconnect();
}
