#!/usr/bin/env node
import { closeDatabase, requireWorkerWorkspace } from './database.mjs';
import { configuredChannels, deliverNotifications } from './notification-delivery.mjs';

const stop = new AbortController();
process.on('message',message => { if (message==='stop') stop.abort(); });
process.once('SIGINT',() => stop.abort());
process.once('SIGTERM',() => stop.abort());

try {
  const channels = configuredChannels(process.env);
  if (!Object.keys(channels).length || !process.env.PROJECTOS_NOTIFICATION_WORKSPACE) {
    console.error('No notification channels or workspace configured');
    process.exitCode = 2;
  } else {
    await requireWorkerWorkspace('delivery',process.env.PROJECTOS_NOTIFICATION_WORKSPACE);
    console.log(JSON.stringify(await deliverNotifications(process.env.PROJECTOS_NOTIFICATION_WORKSPACE, channels, 30, Date.now, stop.signal)));
  }
} catch (error) {
  console.error('Delivery worker failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await closeDatabase();
  if (process.connected) process.disconnect();
}
