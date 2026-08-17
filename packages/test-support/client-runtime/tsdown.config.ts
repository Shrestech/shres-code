import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@shres-code/shres-code-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
