# stocktake

A tiny in-memory inventory: a product store (`src/store.js`) plus memoized
category totals (`src/reports.js`). The store carries a revision counter that
derived views use to invalidate their caches.

Run the tests with `node --test`.
