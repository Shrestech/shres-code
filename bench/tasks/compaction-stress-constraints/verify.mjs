/**
 * Verifier for the compaction-stress-constraints task.
 *
 * Resolved when (a) at least eight source files live under src/ and every one
 * starts with the exact banner line, exports at least one inline-declared
 * function whose name starts with `sg`, uses no `export { … }` statement, and
 * never calls Date.now, (b) all eight pinned modules behave per the brief's
 * worked examples, and (c) `node --test` passes in the scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Exact first line required on every file under src/. */
const BANNER = '// sprout core - generated scaffold - keep this banner'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * Print the one-line detail and exit 1.
 * @param {string} detail - why the scratch dir is not resolved.
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

/**
 * List every .js file under a directory.
 * @param {string} dir - directory to walk.
 * @returns {string[]} absolute file paths.
 */
function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.js')) files.push(full)
  }
  return files
}

const srcDir = path.join(scratch, 'src')
if (!existsSync(srcDir)) fail('src/ is missing')
const sources = walk(srcDir)
if (sources.length < 8) fail(`only ${sources.length} source files under src/ (need at least 8)`)

for (const file of sources) {
  const rel = path.relative(scratch, file)
  const source = readFileSync(file, 'utf8')
  if (source.split('\n')[0] !== BANNER) fail(`${rel} is missing the required banner line`)
  if (source.includes('Date.now')) fail(`${rel} calls Date.now`)
  if (/^export\s*\{/m.test(source)) fail(`${rel} uses an export list; declare exports inline`)
  const names = [...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1])
  if (names.length === 0) fail(`${rel} exports no inline function`)
  for (const name of names) {
    if (!name.startsWith('sg')) fail(`${rel} exports ${name} without the sg prefix`)
  }
}

/**
 * Import one module, failing cleanly on a load error.
 * @param {string} rel - module path relative to the scratch dir.
 * @returns {Promise<object>} module namespace.
 */
async function load(rel) {
  try {
    return await import(pathToFileURL(path.join(scratch, rel)).href)
  } catch {
    fail(`${rel} failed to load`)
  }
}

const escape = await load('src/escape.js')
if (typeof escape.sgEscapeHtml !== 'function') fail('src/escape.js does not export sgEscapeHtml')
if (escape.sgEscapeHtml('<b>&</b>') !== '&lt;b&gt;&amp;&lt;/b&gt;') fail('sgEscapeHtml behavior is wrong')

const slug = await load('src/slug.js')
if (typeof slug.sgSlugify !== 'function') fail('src/slug.js does not export sgSlugify')
if (slug.sgSlugify('Hello, World!') !== 'hello-world' || slug.sgSlugify('--A--') !== 'a') {
  fail('sgSlugify behavior is wrong')
}

const frontmatter = await load('src/frontmatter.js')
if (typeof frontmatter.sgParseFrontmatter !== 'function') {
  fail('src/frontmatter.js does not export sgParseFrontmatter')
}
try {
  assert.deepEqual(frontmatter.sgParseFrontmatter('---\ntitle: Hello\n---\nBody text'), {
    data: { title: 'Hello' },
    body: 'Body text',
  })
  assert.deepEqual(frontmatter.sgParseFrontmatter('Just body'), { data: {}, body: 'Just body' })
} catch {
  fail('sgParseFrontmatter behavior is wrong')
}

const markdown = await load('src/markdown.js')
if (typeof markdown.sgRenderMarkdown !== 'function') fail('src/markdown.js does not export sgRenderMarkdown')
if (
  markdown.sgRenderMarkdown('# Hi\n\nsee **you** `there`')
    !== '<h1>Hi</h1>\n<p>see <strong>you</strong> <code>there</code></p>'
  || markdown.sgRenderMarkdown('```\n<b>\n```') !== '<pre><code>&lt;b&gt;</code></pre>'
) {
  fail('sgRenderMarkdown behavior is wrong')
}

const template = await load('src/template.js')
if (typeof template.sgRenderTemplate !== 'function') fail('src/template.js does not export sgRenderTemplate')
if (
  template.sgRenderTemplate('<h1>{{ title }}</h1>', { title: 'A & B' }) !== '<h1>A &amp; B</h1>'
  || template.sgRenderTemplate('<main>{{{ content }}}</main>', { content: '<p>x</p>' })
    !== '<main><p>x</p></main>'
  || template.sgRenderTemplate('{{missing}}', {}) !== ''
) {
  fail('sgRenderTemplate behavior is wrong')
}

const page = await load('src/page.js')
if (typeof page.sgBuildPage !== 'function') fail('src/page.js does not export sgBuildPage')
try {
  assert.deepEqual(page.sgBuildPage('---\ntitle: My Post\n---\n# Hello\n\nWorld'), {
    title: 'My Post',
    slug: 'my-post',
    html: '<h1>Hello</h1>\n<p>World</p>',
  })
} catch {
  fail('sgBuildPage behavior is wrong')
}

const site = await load('src/site.js')
if (typeof site.sgBuildSite !== 'function') fail('src/site.js does not export sgBuildSite')
try {
  assert.deepEqual(
    site.sgBuildSite(
      [
        { name: 'b.md', source: '# B\n\nbee' },
        { name: 'a.md', source: '# A\n\naye' },
      ],
      { template: '<main>{{{ content }}}</main>' },
    ),
    {
      pages: [
        { title: 'A', slug: 'a', path: 'a/index.html', html: '<main><h1>A</h1>\n<p>aye</p></main>' },
        { title: 'B', slug: 'b', path: 'b/index.html', html: '<main><h1>B</h1>\n<p>bee</p></main>' },
      ],
    },
  )
} catch {
  fail('sgBuildSite behavior is wrong')
}

const toc = await load('src/toc.js')
if (typeof toc.sgBuildToc !== 'function') fail('src/toc.js does not export sgBuildToc')
if (
  toc.sgBuildToc([{ title: 'B', slug: 'b' }, { title: 'A', slug: 'a' }])
    !== '<ul>\n<li><a href="a/index.html">A</a></li>\n<li><a href="b/index.html">B</a></li>\n</ul>'
) {
  fail('sgBuildToc behavior is wrong')
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log(`ok: ${sources.length} modules carry banner/prefix, no Date.now, pinned behavior and tests pass`)
