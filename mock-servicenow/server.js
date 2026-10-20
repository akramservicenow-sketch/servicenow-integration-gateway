/**
 * Standalone mock ServiceNow server (used by docker-compose and `npm run start:mock`).
 * Credentials come from env and default to obvious mock values.
 */
import { createMockServiceNow } from './app.js';

const port = Number(process.env.MOCK_PORT ?? 4000);
const { app } = createMockServiceNow({
  clientId: process.env.MOCK_CLIENT_ID,
  clientSecret: process.env.MOCK_CLIENT_SECRET,
  username: process.env.MOCK_USERNAME,
  password: process.env.MOCK_PASSWORD,
});

app.listen(port, () => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'mock ServiceNow listening', port }) + '\n');
});
