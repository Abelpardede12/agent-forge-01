// CoreForge HTTP server: health probe, git smart HTTP, REST v3, GraphQL and MCP — one process,
// one in-memory store. GraphQL/MCP live in their own modules (graphql.ts, mcp.ts); they are
// mounted when present through a small factory probe, so a missing or mismatched surface never
// takes the git and REST surfaces down with it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitserver.ts';
import { handleRest } from './rest.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function tokenOk(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token !== '' && (store.token === '' || token === store.token);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Try a module's candidate exports for a (store) -> handler factory or a plain handler. */
function adaptHandler(mod: Record<string, unknown>, names: readonly string[]): Handler | null {
  for (const name of names) {
    const candidate = mod[name];
    if (typeof candidate !== 'function') continue;
    try {
      if (candidate.length >= 2) return candidate as Handler;
      const made = (candidate as (s: unknown) => unknown)(store);
      if (typeof made === 'function') return made as Handler;
      const handle = (made as { handle?: unknown } | null)?.handle;
      if (typeof handle === 'function') return handle as Handler;
      return candidate as Handler;
    } catch {
      continue;
    }
  }
  return null;
}

let graphqlHandler: Handler | null = null;
let mcpHandler: Handler | null = null;

async function loadOptionalSurfaces(): Promise<void> {
  try {
    const mod = (await import('./graphql.ts')) as Record<string, unknown>;
    graphqlHandler = adaptHandler(mod, ['createGraphQLHandler', 'createGraphqlHandler', 'createHandler', 'handleGraphQL', 'handler', 'default']);
  } catch {
    graphqlHandler = null;
  }
  try {
    const mod = (await import('./mcp.ts')) as Record<string, unknown>;
    mcpHandler = adaptHandler(mod, ['createMcpHandler', 'createHandler', 'handleMcp', 'handler', 'default']);
  } catch {
    mcpHandler = null;
  }
}

// Load the sibling surfaces before the server answers anything; a failure leaves them unmounted.
await loadOptionalSurfaces();

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    res.setHeader('x-github-request-id', `req-${requestSeq}`);
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    void (async (): Promise<void> => {
      try {
        // GraphQL v4 (unauthenticated is 401).
        if (path === '/api/graphql') {
          if (!tokenOk(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (graphqlHandler === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          await graphqlHandler(req, res);
          return;
        }
        // MCP (unauthenticated is 401).
        if (path === '/mcp') {
          if (!tokenOk(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (mcpHandler === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          await mcpHandler(req, res);
          return;
        }
        // Git smart HTTP at /{owner}/{repo}.git.
        if (await handleGit(req, res)) return;
        // REST v3 under /api/v3.
        if (await handleRest(req, res)) return;
        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        else res.end();
      }
    })();
  });
}
