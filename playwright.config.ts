import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir:'./tests',
  testMatch:'*.spec.ts',
  workers:1,
  timeout:45_000,
  use:{
    baseURL:'http://127.0.0.1:4175',
    locale:'pt-BR',
    launchOptions:process.env.LB_CHROMIUM?{executablePath:process.env.LB_CHROMIUM}:undefined,
  },
  webServer:{
    command:'npm run demo -- --hostname 127.0.0.1 --port 4175',
    url:'http://127.0.0.1:4175/api/health',
    timeout:120_000,
    env:{LOCAL_DB_PORT:'55437',LOCAL_DB_DIR:'.local/e2e-postgres',LB_NEXT_OUTPUT:'.next-test'},
  },
})

