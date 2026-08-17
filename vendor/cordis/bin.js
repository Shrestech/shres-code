#!/usr/bin/env node

import { Context } from '@shres-code/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@shres-code/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@shres-code/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
