import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@roos-code/roos-code-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
