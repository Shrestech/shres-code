/** The node half of the surface plugin is an empty host body by design. */
import { describe, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-browserskill node half', () => {
  it('applies as a no-op host plugin body', () => {
    apply()
  })
})
