/** Test-only external fetch failure; the application's plugins and policies stay enabled. */
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    return Promise.reject(new Error('External fetch is unavailable in the keyless installer fixture'))
  }
  return originalFetch(input, init)
}
