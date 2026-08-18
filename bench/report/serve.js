#!/usr/bin/env node
/**
 * Static file server for the report UI. Serves bench/ui on
 * http://127.0.0.1:7474 with correct MIME types and an index.html
 * fallback so hash-free paths still load the report shell.
 *
 * Usage: node bench/report/serve.js [--port 7474]
 *
 * @module bench/report/serve
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const UI_ROOT = fileURLToPath(new URL('../ui', import.meta.url))

/** MIME types for the file kinds the report UI ships. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
})

/**
 * Resolve a request path to a file inside root, guarding against
 * traversal. Bare directories and extensionless misses fall back to
 * index.html so the report shell loads for any hash-less route.
 * @param {string} root - absolute directory the server is rooted at.
 * @param {string} urlPath - raw request path (query already stripped).
 * @returns {{ file: string, fallback: boolean }} resolved absolute file.
 */
export function resolveRequest(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '')
  const file = resolve(join(root, clean))
  if (file !== root && !file.startsWith(root + sep)) {
    return { file: join(root, 'index.html'), fallback: true }
  }
  if (clean.length === 0 || clean === '.' || extname(clean) === '') {
    return { file: join(root, clean, 'index.html'), fallback: true }
  }
  return { file, fallback: false }
}

/**
 * Content-Type for a file path, defaulting to octet-stream.
 * @param {string} file - file path.
 * @returns {string} MIME type.
 */
export function contentType(file) {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Create the static server bound to 127.0.0.1 only.
 * @param {{ root?: string, port?: number }} [options]
 * @returns {import('node:http').Server} listening server.
 */
export function serve({ root = UI_ROOT, port = 7474 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const { file } = resolveRequest(root, url.pathname)
      let body
      let served = file
      try {
        body = await readFile(file)
      } catch {
        // Hash-routed UI: any extensionless miss loads the shell.
        if (extname(url.pathname) !== '') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        served = join(root, 'index.html')
        body = await readFile(served)
      }
      res.writeHead(200, { 'content-type': contentType(served), 'cache-control': 'no-store' })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(error))
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const bound = server.address()
    console.log(`bench report: http://127.0.0.1:${typeof bound === 'object' && bound ? bound.port : port}`)
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portIndex = process.argv.indexOf('--port')
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 7474
  serve({ port })
}
