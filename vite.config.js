import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, loadEnv } from 'vite';

import { createApiMiddleware } from './src/server/api.js';
import { loadConfig } from './src/server/config.js';
import { CERT_DIR } from './src/server/tls.js';

function taterApi(env) {
  const config = loadConfig({ ...process.env, ...env });
  return {
    name: 'tater-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware(config));
      if (!config.apiKey) {
        server.config.logger.warn('OPENAI_API_KEY is not set — /api/* will fail until it is.');
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const lan = mode === 'lan';

  return {
    plugins: [taterApi(env), ...(lan ? [basicSsl({ certDir: CERT_DIR })] : [])],
    server: {
      port: Number(env.PORT) || 5173,
      host: true,
    },
    resolve: {
      alias: { 'three/addons/': 'three/examples/jsm/' },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 800,
    },
  };
});
