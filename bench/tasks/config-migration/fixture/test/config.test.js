import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { connectionString, dbPort } from '../src/db.js'
import { ttl, maxSize } from '../src/cache.js'
import { appName, listenPort } from '../src/app.js'

const require = createRequire(import.meta.url)

describe('config structure', () => {
  it('config.json uses nested structure', () => {
    const config = require('../config.json', { with: { type: 'json' } })
    assert.equal(typeof config.database, 'object', 'database section missing')
    assert.equal(config.database.host, 'localhost')
    assert.equal(config.database.port, 5432)
    assert.equal(config.database.name, 'appdb')
    assert.equal(typeof config.cache, 'object', 'cache section missing')
    assert.equal(config.cache.ttl, 3600)
    assert.equal(config.cache.maxSize, 1000)
    assert.equal(typeof config.app, 'object', 'app section missing')
    assert.equal(config.app.name, 'my-service')
    assert.equal(config.app.port, 8080)
  })

  it('flat keys are gone', () => {
    const config = require('../config.json', { with: { type: 'json' } })
    assert.equal(config.db_host, undefined)
    assert.equal(config.db_port, undefined)
    assert.equal(config.db_name, undefined)
    assert.equal(config.cache_ttl, undefined)
    assert.equal(config.cache_max_size, undefined)
    assert.equal(config.app_name, undefined)
    assert.equal(config.app_port, undefined)
  })
})

describe('db module', () => {
  it('connectionString uses nested config', () => {
    assert.equal(connectionString(), 'postgres://localhost:5432/appdb')
  })

  it('dbPort returns the port', () => {
    assert.equal(dbPort(), 5432)
  })
})

describe('cache module', () => {
  it('ttl returns cache TTL', () => {
    assert.equal(ttl(), 3600)
  })

  it('maxSize returns cache max size', () => {
    assert.equal(maxSize(), 1000)
  })
})

describe('app module', () => {
  it('appName returns the name', () => {
    assert.equal(appName(), 'my-service')
  })

  it('listenPort returns the port', () => {
    assert.equal(listenPort(), 8080)
  })
})
