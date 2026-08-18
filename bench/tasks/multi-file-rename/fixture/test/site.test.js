import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify, isValidSlug } from '../src/slugify.js'
import { Post } from '../src/post.js'
import { Site } from '../src/site.js'

test('slugify lowercases and dashes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
})

test('isValidSlug accepts clean slugs', () => {
  assert.equal(isValidSlug('hello-world'), true)
  assert.equal(isValidSlug('Hello World'), false)
})

test('Post derives its slug from the title', () => {
  assert.equal(new Post('My First Post', '...').slug, 'my-first-post')
})

test('Site rejects duplicate slugs and finds posts', () => {
  const site = new Site()
  site.addPost('Hello World', 'a')
  assert.throws(() => site.addPost('Hello, World', 'b'))
  assert.equal(site.findPost('hello-world').title, 'Hello World')
})
