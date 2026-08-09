import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadTls } from './tls.js';

const config = loadConfig();
const tls = await loadTls({ https: process.argv.includes('--https') });

const app = createApp(config, { tls });

app.listen(config.port, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`tater → ${scheme}://localhost:${config.port}`);
  if (tls) {
    console.log(`      → ${scheme}://<this machine on the wifi>:${config.port}`);
  }
  if (!config.apiKey) {
    console.warn('OPENAI_API_KEY is not set — /api/* will fail until it is.');
  }
  const connectors = app.connectors.agents;
  console.log(connectors.length
    ? `connectors → ${connectors.join(', ')}, working in ${app.connectors.settings().cwd}`
    : 'connectors → none yet, switch one on in the connectors panel');
});
