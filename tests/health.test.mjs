// Health check regression tests: build a map of a small sample project and check which endpoints
// Health reports as open to anyone. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'skills', 'floorplan', 'scripts');

/** Copies a fixture to a temp folder, maps it as one module, and returns the built graph. */
function buildFixture(name) {
  const root = copyFixture(name);
  const graph = mapIt(root);
  fs.rmSync(root, { recursive: true, force: true });
  return graph;
}

function copyFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floorplan-${name}-`));
  fs.cpSync(path.join(here, 'fixtures', name), root, { recursive: true });
  fs.mkdirSync(path.join(root, 'floorplan'));
  return root;
}

/** Maps a copied fixture as one module (with an optional `health` section) and returns the built graph. */
function mapIt(root, health) {
  fs.writeFileSync(path.join(root, 'floorplan', 'architecture.json'), JSON.stringify({
    project: { name: path.basename(root), summary: 'Test fixture.' },
    nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
    health,
  }));
  for (const s of ['scan.mjs', 'build.mjs']) execFileSync(process.execPath, [path.join(scripts, s), root, '--no-claude-md'], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(root, 'floorplan', 'graph.json'), 'utf8'));
}

/** "METHOD /path" for every endpoint Health reports as callable by anyone. */
function openEndpoints(graph) {
  return graph.health.issues
    .filter((i) => i.kind === 'unprotected-endpoint')
    .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
    .map((r) => `${r.m} ${r.p}`)
    .sort();
}

test('Express: path-scoped middleware, parent-router checks and named handlers', () => {
  const graph = buildFixture('express-mount-prefixes');
  // app.use('/api/auth/login', authLimiter) is a rate limiter, not a router mount: no route gets that prefix
  assert.deepEqual(graph.routes.map((r) => `${r.m} ${r.p}`).sort(), [
    'DELETE /api/admin/users/:id', 'DELETE /api/items/:id', 'GET /api/items', 'GET /api/ping',
    'POST /api/admin/users/:id/block', 'PUT /api/items/:id',
  ]);
  // router.use(auth) before router.use('/users', users) protects the users routes, and
  // router.put('/:id', auth, updateItem) is protected though its handler is a named function
  assert.deepEqual(openEndpoints(graph).filter((e) => !e.startsWith('GET')), ['DELETE /api/items/:id']);
});

test('Accepted findings stay hidden only while the reviewed code is unchanged', () => {
  const root = copyFixture('express-mount-prefixes');
  try {
    const del = 'DELETE /api/items/:id';
    const accept = (code) => ({ accepted: [{ endpoint: del, reason: 'public on purpose', code }, { endpoint: 'GET /api/gone', reason: 'removed since' }] });
    // not pinned yet: still shown, and the build hands over today's fingerprint
    let graph = mapIt(root, accept(undefined));
    assert.ok(openEndpoints(graph).includes(del));
    const [pending] = graph.health.recheck;
    assert.equal(pending.ref, del);
    assert.equal(pending.status, 'unpinned');
    assert.deepEqual(graph.health.stale, ['GET /api/gone']);
    // pinned: hidden
    graph = mapIt(root, accept(pending.code));
    assert.ok(!openEndpoints(graph).includes(del));
    assert.deepEqual(graph.health.accepted.map((x) => x.ref), [del]);
    // the handler, in another file, changes: shown again, with a note saying why
    const handlers = path.join(root, 'routes', 'itemHandlers.js');
    fs.writeFileSync(handlers, fs.readFileSync(handlers, 'utf8').replace('res.status(204).end()', 'db.wipe() && res.status(204).end()'));
    graph = mapIt(root, accept(pending.code));
    assert.ok(openEndpoints(graph).includes(del));
    assert.equal(graph.health.recheck[0].status, 'changed');
    const issue = graph.health.issues.find((i) => i.items.some((id) => id.startsWith('r:') && `${graph.routes[+id.slice(2)].m} ${graph.routes[+id.slice(2)].p}` === del));
    assert.match(Object.values(issue.notes).join(' '), /code changed since/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Accepted findings come back when a wrapped, CommonJS or default-exported handler changes, not when a neighbour does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-accept-'));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  const check = 'if (req.query.k !== process.env.K) return res.sendStatus(403); ';
  try {
    w('package.json', JSON.stringify({ name: 'p', type: 'module', dependencies: { express: '4' } }));
    w('server.js', `import express from 'express';\nimport r from './routes/api.js';\nconst app = express();\napp.use('/api', r);\napp.listen(3000);\n`);
    w('services/a.js', `export async function loadA() { return { a: 1 }; }\n`);
    w('utils/wrap.js', `export const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);\n`);
    w('controllers/c.js', [
      `import { loadA } from '../services/a.js';`,
      `export async function hA(req, res) { ${check}res.json(await loadA()); }`,
      `export async function hB(req, res) { ${check}res.json({ b: 1 }); }`,
      `exports.hC = async (req, res) => { ${check}res.json({ c: 1 }); };`,
      `export default async function hG(req, res) { ${check}res.json({ g: 1 }); }`,
    ].join('\n') + '\n');
    const routes = `import { Router } from 'express';\nimport { asyncHandler } from '../utils/wrap.js';\nimport * as c from '../controllers/c.js';\nconst router = Router();\n` +
      `router.post('/b', asyncHandler(c.hB));\nrouter.post('/c', c.hC);\nrouter.post('/g', c.hG);\nrouter.post('/h', rateLimit({ max: 5 }), c.hA);\nexport default router;\n`;
    w('routes/api.js', routes);
    fs.mkdirSync(path.join(root, 'floorplan'));
    const eps = ['b', 'c', 'g', 'h'].map((x) => 'POST /api/' + x);
    let graph = mapIt(root, { accepted: eps.map((endpoint) => ({ endpoint, reason: 'checks a key' })) });
    const pinned = { accepted: graph.health.recheck.map((x) => ({ endpoint: x.ref, reason: 'checks a key', code: x.code })) };
    assert.deepEqual(pinned.accepted.map((x) => x.endpoint).sort(), eps);
    // a new route next door, with a comment above it, leaves the reviewed ones alone
    w('routes/api.js', routes.replace('export default router;', `// a new one\nrouter.get('/x', (req, res) => res.json([]));\nexport default router;`));
    graph = mapIt(root, pinned);
    assert.deepEqual(graph.health.accepted.map((x) => x.ref).sort(), eps);
    // the service behind /h changes: only /h is shown again
    w('services/a.js', `export async function loadA() { return { a: 1, secret: process.env.K }; }\n`);
    graph = mapIt(root, pinned);
    assert.deepEqual(graph.health.recheck.map((x) => x.ref), ['POST /api/h']);
    // the key check goes from every handler: every one is shown again
    const c = path.join(root, 'controllers', 'c.js');
    fs.writeFileSync(c, fs.readFileSync(c, 'utf8').replaceAll(check, ''));
    graph = mapIt(root, pinned);
    assert.deepEqual(graph.health.accepted, []);
    assert.deepEqual(graph.health.recheck.map((x) => `${x.ref} ${x.status}`).sort(), eps.map((e) => `${e} changed`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FastAPI: Annotated dependency aliases count as sign-in checks (#4)', () => {
  const graph = buildFixture('fastapi-annotated');
  assert.ok(graph.routes.length >= 7, `expected the sample's 7 endpoints, found ${graph.routes.length}`);
  // imported alias (AdminUser), same-file alias (MemberUser), an alias whose dependency takes
  // AdminUser (OwnedOffice) and an alias whose own name reads as a check (AdminAccess) are all protected;
  // routes with only a database session (SessionDep, SqlSessionDep over get_sql_session) aren't
  assert.deepEqual(openEndpoints(graph), ['POST /comments', 'POST /feedback']);
});

test('FastAPI: public readiness and liveness endpoints are not security warnings (#7)', () => {
  const graph = buildFixture('fastapi-annotated');
  const paths = graph.routes.map((r) => r.p);
  assert.ok(paths.includes('/readyz'));
  assert.ok(paths.includes('/livez'));
  assert.ok(!openEndpoints(graph).includes('GET /readyz'));
  assert.ok(!openEndpoints(graph).includes('GET /livez'));
});

test('FastAPI: a named guard dependency is not a public endpoint (#7)', () => {
  const graph = buildFixture('fastapi-guard-name');
  assert.deepEqual(openEndpoints(graph), ['POST /billing/open']);
});

test('FastAPI: header tokens are guarded only when the handler validates them (#7)', () => {
  const graph = buildFixture('fastapi-header-guard');
  assert.ok(graph.routes.some((r) => r.p === '/invites/checked'));
  assert.deepEqual(openEndpoints(graph), ['POST /invites/unchecked']);
});

test('FastAPI: a signature validator in an imported helper protects the route (#7)', () => {
  const graph = buildFixture('fastapi-signature-helper');
  assert.ok(graph.routes.some((r) => r.p === '/webhook/verified'));
  assert.deepEqual(openEndpoints(graph), ['POST /webhook/unverified']);
});

test('FastAPI: checks added where a router is included count as sign-in checks', () => {
  const graph = buildFixture('fastapi-include-router');
  assert.equal(graph.routes.length, 4, `expected the sample's 4 endpoints, found ${graph.routes.length}`);
  // the router imported under another name (item_routes) still gets its prefix
  assert.ok(graph.routes.some((r) => r.p === '/items/{item_id}'), 'expected /items/{item_id}');
  // app.include_router(staff.router, dependencies=[Depends(require_admin)]) protects every staff route,
  // even with a package also called staff imported first; so does a check beside a database session,
  // over several lines; a database session alone (orders) protects nothing
  assert.deepEqual(openEndpoints(graph), ['POST /orders']);
});

test('Fastify: route-object hooks guard only their own route, not schema or neighbors', () => {
  const graph = buildFixture('fastify-object-guards');
  assert.deepEqual(openEndpoints(graph), [
    'POST /api/neighbor-open',
    'POST /api/object-open',
    'POST /api/object-schema-only',
  ]);
});

test('Express: a check before a named handler counts, and each route is judged on its own arguments', () => {
  const graph = buildFixture('express-named-handlers');
  assert.equal(graph.routes.length, 5, `expected the sample's 5 endpoints, found ${graph.routes.length}`);
  // router.post('/books', requireAuth, createBook) is protected; a handler named like a check
  // (updateUser) isn't a check, and a check on the next route doesn't protect the one before it
  assert.deepEqual(openEndpoints(graph), ['GET /api/books', 'POST /api/notes', 'PUT /api/users/:id']);
});

test('Flask: login decorators count, while logging and misplaced decorators do not (#123)', () => {
  const graph = buildFixture('flask-login');
  // login_required, login_required_json and logged_in_required count; log_call, logging_required and
  // logged_request are logging, and a check above the route line does nothing
  assert.equal(graph.routes.length, 7);
  assert.deepEqual(openEndpoints(graph), [
    'POST /actions/log-call',
    'POST /actions/logged',
    'POST /actions/logging',
    'POST /actions/misplaced',
  ]);
});

test('FastAPI: dependencies are judged by what they check, not only by their name (#112, #117, #102)', () => {
  const graph = buildFixture('fastapi-dependency-checks');
  assert.equal(graph.routes.length, 20, `expected the sample's 20 endpoints, found ${graph.routes.length}`);
  // checks: validate_api_key and validate_jwt (#112); a guard factory's result, a neutral-named factory's
  // result, a class whose __call__ raises 403 and a neutral name that raises 401 (#117 A, B); a factory's
  // result on the whole router (#117 C); a list kept in a constant (#117 D); a Depends() kept in a
  // variable, listed or as a parameter default (#102).
  // Still open: a schema validator (Depends(validate_payload), @validate), a page number, a lookup that
  // answers 404 and a factory that checks nothing, however they are passed.
  assert.deepEqual(openEndpoints(graph), [
    'PATCH /tickets/{ticket_id}',
    'POST /catalog',
    'POST /drafts',
    'POST /notes/paged',
    'POST /notes/paged-default',
    'POST /orders/{order_id}/copy',
    'POST /orders/{order_id}/export',
    'POST /orders/{order_id}/notes',
    'PUT /tickets/{ticket_id}',
  ]);
});

test("Hono routers under arbitrary variable names are scanned, and mounts compose (#98)", () => {
  const graph = buildFixture("hono-named-routers");
  const paths = graph.routes.map((r) => `${r.m} ${r.p}`).sort();
  // routes on frentes/croquis (arbitrary names) appear under their router prefixes
  for (const suffix of ["frentes/lista", "frentes/vieja", "croquis/mapa", "health"]) {
    assert.ok(paths.some((p) => p.endsWith(suffix)), `expected a route ending in ${suffix}, got: ${paths}`);
  }
  // each module router keeps its own prefix: croquis's mount must not leak onto frentes routes
  assert.ok(!paths.some((p) => p.endsWith("croquis/lista")), `unexpected cross-router prefix, got: ${paths}`);
});
