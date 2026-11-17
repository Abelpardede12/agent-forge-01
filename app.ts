import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore } from './store.ts';
import { createGitHandlers } from './gitserver.ts';
import { createRestHandlers } from './rest.ts';
import { createGraphqlHandlers } from './graphql.ts';
import { createMcpHandlers } from './mcp.ts';

import { randomUUID } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID(), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const git = createGitHandlers(store, token);
  const rest = createRestHandlers(store, token);
  const graphql = createGraphqlHandlers(store, token);
  const mcp = createMcpHandlers(store, token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Hand off to the first surface that claims the request, in order.
        if (await git(req, res)) return;
        if (await rest(req, res)) return;
        if (await graphql(req, res)) return;
        if (await mcp(req, res)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
