#!/usr/bin/env node

import { Context } from '@roos-code/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@roos-code/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@roos-code/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
