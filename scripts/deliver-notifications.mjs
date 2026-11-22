#!/usr/bin/env node
import { closeDatabase, requireWorkerWorkspace } from './database.mjs';
import { configuredChannels, deliverNotifications } from './notification-delivery.mjs';

try {
  const channels = configuredChannels(process.env);
  if (!Object.keys(channels).length || !process.env.PROJECTOS_NOTIFICATION_WORKSPACE) {
    console.error('No notification channels or workspace configured');
    process.exitCode = 2;
  } else {
    await requireWorkerWorkspace('delivery',process.env.PROJECTOS_NOTIFICATION_WORKSPACE);
    console.log(JSON.stringify(await deliverNotifications(process.env.PROJECTOS_NOTIFICATION_WORKSPACE, channels)));
  }
} catch (error) {
  console.error('Delivery worker failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
