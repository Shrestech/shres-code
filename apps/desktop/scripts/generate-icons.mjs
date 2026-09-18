import { createRequire } from 'node:module'
const require = createRequire('/Users/parthmondal/git/shres-code-desktop/packages/attachment/attachment-local/package.json')
const sharp = require('sharp')
import { writeFileSync, mkdirSync } from 'node:fs'

const svg = '/Users/parthmondal/git/shres-code-desktop/apps/web/public/favicon.svg'
mkdirSync('apps/desktop/build/icon.iconset', { recursive: true })
const sizes = [
  [16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'], [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'], [256, 'icon_128x128@2x'], [256, 'icon_256x256'], [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'], [1024, 'icon_512x512@2x'],
]
for (const [size, name] of sizes) {
  writeFileSync('apps/desktop/build/icon.iconset/' + name + '.png', await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer())
}
writeFileSync('apps/desktop/build/icon.png',
  await sharp(svg, { density: 300 }).resize(1024, 1024).png().toBuffer())
console.log('pngs generated')

// Regenerate: node apps/desktop/scripts/generate-icons.mjs && iconutil -c icns apps/desktop/build/icon.iconset -o apps/desktop/build/icon.icns
