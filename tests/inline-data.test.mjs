// Text from the mapped code (comments, docstrings) is inlined into the map as data and must stay data:
// a template placeholder in a comment is not filled in, and '</script>' or '<!--' can't end the data
// script or start markup. Checked on the built map and on an exported copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shopApp, run, readGraph, cleanup, SKILL } from './helpers.mjs';

const MARK = 'fp-injected-marker';
// one payload per file, since a file's description is cut short
const HOSTILE = [
  '<!--__UI_EXTENSIONS__-->', '/*__FLOORPLAN_DATA__*/null', '__FLOORPLAN_TITLE__ __FLOORPLAN_LOGO__ __FLOORPLAN_FAVICON__',
  '/*__FONTS__*/ /*__GRAPH_QUERY__*/ <!--__ELK_SCRIPT__--> </head>',
  `</script><script>window.${MARK.replace(/-/g, '_')}=1</script>`, `<img src=x onerror="${MARK}">`, '<!--<script>',
];
const DATA_START = '<script>window.FLOORPLAN = ';

/** The text of the data script as the browser would cut it: up to the first '</script'. */
function dataScript(html) {
  const a = html.indexOf(DATA_START);
  assert.ok(a >= 0, 'the page has a data script');
  const b = html.toLowerCase().indexOf('</script', a);
  return html.slice(a + DATA_START.length, b);
}
function checkPage(html, graph) {
  assert.equal(html.split(DATA_START).length - 1, 1, 'exactly one data script');
  const body = dataScript(html);
  assert.ok(body.endsWith(';'), 'the data script ends right after the graph');
  assert.deepEqual(JSON.parse(body.slice(0, -1)), graph, 'the graph reads back intact');
  assert.ok(!body.includes('<'), "no '<' inside the data script");
  const outside = html.replace(body, '');
  assert.ok(!outside.includes(MARK), 'the hostile comment appears nowhere outside the data');
  const uiFiles = fs.readdirSync(path.join(SKILL, 'assets', 'ui')).filter((n) => n.endsWith('.js'));
  assert.equal(outside.split('<script>/* ui/').length - 1, uiFiles.length, 'every UI script is in the page, outside the data');
  assert.ok(!outside.includes('<!--__UI_EXTENSIONS__-->'), 'the real placeholder is filled in');
}

let root, graph;
before(() => {
  root = shopApp();
  HOSTILE.forEach((text, i) => fs.writeFileSync(path.join(root, 'shop-api', `helper${i}.js`), `// Helper ${i}: ${text}\nexport const noop${i} = () => {};\n`));
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('the hostile comments reach the graph unchanged', () => {
  HOSTILE.forEach((text, i) => {
    const f = graph.files.find((x) => x.p === `shop-api/helper${i}.js`);
    assert.ok(f, `helper${i}.js is on the map`);
    assert.ok(f.doc.includes(text), `helper${i}.js keeps its comment: ${f.doc}`);
  });
});

test('the built map keeps the comment as data', () => {
  checkPage(fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'), graph);
});

test('an exported copy keeps the comment as data', () => {
  const file = path.join(root, 'exported.html');
  execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', file, '--include', 'flows,notes,recent,health'], { cwd: root, encoding: 'utf8' });
  const html = fs.readFileSync(file, 'utf8');
  const g = JSON.parse(dataScript(html).slice(0, -1));
  assert.ok(g.meta.exported);
  checkPage(html, g);
});

test('the map declares a content security policy that allows no outside requests', () => {
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(csp, 'a CSP meta tag');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'(;|$)/);
});
