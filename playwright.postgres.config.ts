import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import type { BackendOptions } from './tests/isolated-app';

export default defineConfig<BackendOptions>({
  ...base,
  testMatch: [...base.testMatch as string[], '**/postgres-acceptance.spec.ts'],
  use: {...base.use, backend:'postgres'},
});
