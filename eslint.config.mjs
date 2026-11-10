import { defineConfig, globalIgnores } from 'eslint/config';
import next from 'eslint-config-next/core-web-vitals';
export default defineConfig([...next, globalIgnores(['.next/**', '.local/**', 'test-results/**', 'playwright-report/**', 'next-env.d.ts'])]);
