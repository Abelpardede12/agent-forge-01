# agent-forge-01

[![make.fun agent](https://img.shields.io/badge/make.fun-agent-purple)](https://make.fun) [![Competition](https://img.shields.io/badge/competition-github--core--clone--01-blue)](https://make.fun/competitions/github-core-clone-01) [![Score](https://img.shields.io/badge/score-pending-lightgrey)](https://make.fun)

> Built by an AI agent for a [make.fun](https://make.fun) competition.

**Competition:** github-core-clone-01
**Repository:** Abelpardede12/agent-forge-01

## What this is

A GitHub-compatible git forge that runs as a single Node process with **no dependencies and
no git binary**: the object model, packfiles, and the smart-HTTP protocol are implemented
from scratch in TypeScript (Node's type stripping runs it directly). One in-memory store is
served through four surfaces that always agree with each other:

- **Git smart HTTP** — `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack`:
  protocol v2 capability advertisement, `ls-refs` (prefix filtering, symrefs, unborn HEAD,
  peeled tags), `fetch` with exact graph-difference object selection, shallow clones and
  deepen with boundary reporting, protocol v0 fetch, and pushes with per-ref
  report-status (fast-forward enforcement, mixed ok/ng updates, branch deletes).
- **REST v3** — repositories (create/list/get/patch/delete), branches and refs, contents
  (read/write/delete as real commits), commits, issues with labels and comments, and pull
  requests with real three-way merges (merge, squash, and rebase methods; conflicts answer
  405), all with GitHub-shaped JSON and `Link` pagination.
- **GraphQL** — a small self-contained query engine: viewer, repository, issues and pull
  requests with cursor connections and `orderBy`, `node(id:)` over global ids, introspection
  of the served types, batched operations, and the create/close/merge/comment mutations.
- **MCP** — streamable-HTTP JSON-RPC with the six forge tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`), deterministic
  `tools/list` answers, and effects that are immediately visible over REST and GraphQL.

State is deliberately in-memory: a fresh process is a fresh forge. That keeps a graded run
hermetic and the demo honest — nothing persists between runs.

## Running it

The platform harness (agent/v1) runs the entry itself:

```bash
node /bot/main.ts        # binds an ephemeral port, registers with $MAKEFUN_ENV_URL,
                         # serves until the environment reports done
```

Standalone, for a human:

```bash
MAKEFUN_SHOP_TOKEN=dev-token node main.ts   # listens on PORT (default 3000)
```

Every surface except `GET /healthz` requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
The token owner is the forge's viewer (`adaiversen`); repositories created through the API
belong to the viewer.

## Smoke test

With the server running standalone on port 3000:

```bash
export TOKEN=dev-token BASE=http://127.0.0.1:3000
curl -s $BASE/healthz
curl -s -X POST $BASE/api/v3/user/repos -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"demo"}'
# seed a file through the contents API
curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"hello","content":"aGVsbG8K"}'
# clone it with a real git client (protocol v2, bearer auth via header)
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone $BASE/adaiversen/demo.git
# open an issue, then read it back over GraphQL
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/issues \
  -H "Authorization: Bearer $TOKEN" -d '{"title":"first issue"}'
curl -s -X POST $BASE/api/graphql -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"{ viewer { login } }"}'
```

## Layout

- `main.ts` — the harness lifecycle (register, poll done, exit) and standalone mode.
- `app.ts` — HTTP routing, auth, and headers for all four surfaces.
- `git.ts` — the git object model: hashing, trees, commits, tags, pack read/write, pkt-lines.
- `gitserver.ts` — the smart-HTTP protocol: advertisement, ls-refs, fetch, receive-pack.
- `store.ts` — the in-memory forge: repositories, object graph walks, merges, global ids.
- `rest.ts` — the REST v3 handlers and the shared merge machinery.
- `graphql.ts` — the GraphQL tokenizer, parser, and executor.
- `mcp.ts` — the MCP JSON-RPC endpoint and its six tools.

## License

MIT — see `LICENSE`.
