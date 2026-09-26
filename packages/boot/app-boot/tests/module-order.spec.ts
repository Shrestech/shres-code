/** The profile-first import order exercises the eager protected-bundle set's dependency on initialized template constants. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES } from '../src/profile.ts'
import * as appBoot from '../src/index.ts'

describe('module order', () => {
  it('imports the barrel after the profile module with consistent public templates', () => {
    expect(appBoot.PROFILE_TEMPLATES).toEqual(PROFILE_TEMPLATES)
    expect(appBoot.DEFAULT_PROFILE_BUNDLES).toEqual(DEFAULT_PROFILE_BUNDLES)
    expect(appBoot.PROFILE_TEMPLATES.web).toContain('@shres-code/shres-code-base')
    expect(appBoot.DEFAULT_PROFILE_BUNDLES).toContain('@shres-code/shres-code-base')
  })
})
