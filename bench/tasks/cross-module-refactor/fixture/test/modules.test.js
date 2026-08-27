import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUser, updateEmail } from '../src/users.js'
import { placeOrder, cancelOrder } from '../src/orders.js'
import { registerProduct, lookupProduct } from '../src/products.js'

describe('users', () => {
  it('createUser succeeds with valid data', () => {
    const r = createUser({ id: 'usr001', email: 'a@b.com', name: 'Alice' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.user, { id: 'usr001', email: 'a@b.com', name: 'Alice' })
  })

  it('createUser rejects bad id', () => {
    const r = createUser({ id: '!', email: 'a@b.com', name: 'X' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid id')
  })

  it('createUser rejects bad email', () => {
    const r = createUser({ id: 'usr001', email: 'nope', name: 'X' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid email')
  })

  it('updateEmail validates both arguments', () => {
    assert.equal(updateEmail('usr001', 'new@e.com').ok, true)
    assert.equal(updateEmail('!', 'new@e.com').ok, false)
    assert.equal(updateEmail('usr001', 'bad').ok, false)
  })
})

describe('orders', () => {
  it('placeOrder succeeds with valid data', () => {
    const r = placeOrder({ orderId: 'ord001', customerEmail: 'c@d.com', items: ['x'] })
    assert.equal(r.ok, true)
    assert.deepEqual(r.order, { orderId: 'ord001', customerEmail: 'c@d.com', items: ['x'] })
  })

  it('placeOrder rejects bad order id', () => {
    assert.equal(placeOrder({ orderId: '!', customerEmail: 'c@d.com', items: ['x'] }).ok, false)
  })

  it('placeOrder rejects bad email', () => {
    assert.equal(placeOrder({ orderId: 'ord001', customerEmail: 'no', items: ['x'] }).ok, false)
  })

  it('placeOrder rejects empty items', () => {
    assert.equal(placeOrder({ orderId: 'ord001', customerEmail: 'c@d.com', items: [] }).ok, false)
  })

  it('cancelOrder validates id', () => {
    assert.equal(cancelOrder('ord001').ok, true)
    assert.equal(cancelOrder('!').ok, false)
  })
})

describe('products', () => {
  it('registerProduct succeeds with valid data', () => {
    const r = registerProduct({ productId: 'prod01', vendorEmail: 'v@e.com', title: 'Widget' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.product, { productId: 'prod01', vendorEmail: 'v@e.com', title: 'Widget' })
  })

  it('registerProduct rejects bad id', () => {
    assert.equal(registerProduct({ productId: '!', vendorEmail: 'v@e.com', title: 'X' }).ok, false)
  })

  it('registerProduct rejects bad email', () => {
    assert.equal(registerProduct({ productId: 'prod01', vendorEmail: 'bad', title: 'X' }).ok, false)
  })

  it('lookupProduct validates id', () => {
    assert.equal(lookupProduct('prod01').ok, true)
    assert.equal(lookupProduct('!!').ok, false)
  })
})
