/** A packaged app creates its profile without replacing existing user configuration. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureDesktopProfile } from '../src/profile-init.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profilePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'shres-desktop-profile-'))
  roots.push(root)
  return join(root, 'profiles', 'desktop')
}

it('creates a fresh desktop profile with the shipped bundle order', () => {
  const profile = profilePath()
  ensureDesktopProfile(profile, '0.1.0-test')
  expect(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))).toEqual({
    name: '@shres-code/shres-code-desktop-profile',
    version: '0.1.0-test',
    private: true,
    dependencies: {},
    shres: { profile: { bundles: ['@shres-code/shres-code-base', '@shres-code/shres-code-web-app'] } },
  })
})

it.each(['{"shres":{"profile":{"bundles":["my-plugin"]}}}', '{broken'])('leaves existing profiles for the host loader to validate: %s', (existing) => {
  const profile = profilePath()
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), existing)
  ensureDesktopProfile(profile, '0.1.0-test')
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(existing)
})

it('reports a profile directory that cannot be created', () => {
  const profile = profilePath()
  mkdirSync(join(profile, '..'), { recursive: true })
  writeFileSync(profile, 'occupied')
  expect(() => { ensureDesktopProfile(profile, '0.1.0-test') }).toThrow()
})
