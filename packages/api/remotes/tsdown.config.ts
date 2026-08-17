import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@shres-code/shres-code-api-remotes',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
