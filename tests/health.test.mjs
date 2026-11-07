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
  const graph = buildFixture('express-mounts');
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
  const root = copyFixture('express-mounts');
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
    w('utils/wrap.js', `export const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);\n`);
    w('controllers/c.js', [
      `export async function hA(req, res) { ${check}res.json({ a: 1 }); }`,
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
