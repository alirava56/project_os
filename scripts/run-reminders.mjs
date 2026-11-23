#!/usr/bin/env node
import { closeDatabase, requireWorkerWorkspace } from './database.mjs';
import { configuredChannels } from './notification-delivery.mjs';
import { reconcileReminders } from './reminder-scheduler.mjs';

if (process.connected) {
  process.on('message',() => { /* Finish the current transaction before exit. */ });
  process.once('SIGINT',() => {});
  process.once('SIGTERM',() => {});
}

try {
  const configured = process.env.PROJECTOS_REMINDER_OFFSETS;
  const offsets = configured === undefined ? undefined : [...new Set(configured.split(',').map(Number))];
  if (offsets?.some(offset => !Number.isSafeInteger(offset) || offset < 0 || offset > 60)) throw new Error('Invalid reminder offsets');
  const workspace = process.env.PROJECTOS_NOTIFICATION_WORKSPACE;
  await requireWorkerWorkspace('reminder',workspace);
  console.log(JSON.stringify(await reconcileReminders({
    channels: Object.keys(configuredChannels(process.env)), offsets,
    telegramDetails:process.env.PROJECTOS_TELEGRAM_PROJECT_DETAILS === 'enabled',
    notificationWorkspace: workspace,
  })));
} catch (error) {
  console.error('Reminder worker failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await closeDatabase();
  if (process.connected) process.disconnect();
}
