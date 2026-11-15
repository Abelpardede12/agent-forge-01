// Entry point. Two modes:
//   - Agent mode: $MAKEFUN_ENV_URL is set. Bind an ephemeral port, register it
//     with the environment, then poll /done until the trial ends and exit 0.
//   - Standalone: no env URL. Listen on $PORT (default 3000) until stopped.
// The bearer token comes from $MAKEFUN_SHOP_TOKEN.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
if (token === '') {
  console.error('MAKEFUN_SHOP_TOKEN is not set');
  process.exit(1);
}

const store = new Store();
const server = createApp(store, token);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    const base = envUrl.replace(/\/+$/, '');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('server did not bind an address');
    }
    const port = address.port;
    const register = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (!register.ok) {
      throw new Error(`register failed: HTTP ${register.status}`);
    }
    for (;;) {
      await sleep(500);
      let done = false;
      try {
        const response = await fetch(`${base}/done`);
        if (response.ok) {
          const payload = (await response.json()) as { done?: unknown };
          done = payload.done === true;
        }
      } catch {
        done = false;
      }
      if (done) break;
    }
    server.close();
    process.exit(0);
  }

  const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`coreforge listening on :${port}`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
