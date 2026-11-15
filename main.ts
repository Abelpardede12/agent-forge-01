// main.ts — the entrypoint the platform runs (agent/v1 harness). The lifecycle: bind an
// ephemeral port, register it with the environment, then poll the environment's /done flag
// until the trial ends and exit cleanly. Run standalone (no MAKEFUN_ENV_URL), it instead
// listens on PORT (default 3000) so a human can drive the forge by hand.

import { createForgeServer } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');

async function pollUntilDone(url: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${url}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done) return;
      }
    } catch {
      // The environment may not be listening yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const server = createForgeServer();
  if (!envUrl) {
    const port = Number(process.env.PORT ?? '3000') || 3000;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`forge listening on http://127.0.0.1:${port}`);
    // Standalone mode serves until killed: never resolve, or the process would exit.
    await new Promise<void>(() => {});
    return;
  }
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral port');
  const register = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: address.port }),
  });
  if (!register.ok && register.status !== 409) {
    throw new Error(`register failed: ${register.status}`);
  }
  await pollUntilDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
