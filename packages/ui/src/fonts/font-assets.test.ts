import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fonts = `${root}/packages/ui/src/fonts`
const faces = [
  ['Regular', 400, 'a057e02e068452571cdd1c4c50fa5d03dc5af5ce50ccb95cfc731035b8c698d8'],
  ['Medium', 500, 'b9ffd2641da8be249315f4ce85f221343fc94e5c599e916fc21884ddcd65a380'],
  ['Bold', 700, '2408b801c823991d59cc9cde288a909e9496c47cfb19e14fc0dde53f04b8a0df'],
] as const

for (const [name, weight, hash] of faces) test(`LT Superior Serif ${weight}: original vendor OTF and truthful weight`, () => {
  const bytes = readFileSync(`${fonts}/superior-serif/LTSuperiorSerif-${name}.otf`)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, 'Unmodified owner-supplied face')
  assert.equal(bytes.toString('ascii', 0, 4), 'OTTO')
  let os2 = 0
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const offset = 12 + i * 16
    if (bytes.toString('ascii', offset, offset + 4) === 'OS/2') os2 = bytes.readUInt32BE(offset + 8)
  }
  assert(os2, 'OS/2 table present')
  assert.equal(bytes.readUInt16BE(os2 + 4), weight)
})

test('font faces retain exact aliases, swap loading and real upright descriptors', () => {
  const css = readFileSync(`${fonts}/superior-serif.css`, 'utf8')
  assert.equal((css.match(/font-family: "LT Superior Serif"/g) ?? []).length, 3)
  assert.equal((css.match(/font-style: normal/g) ?? []).length, 3)
  assert.equal((css.match(/font-display: swap/g) ?? []).length, 3)
  assert.doesNotMatch(css, /font-style: italic/, 'No nonexistent vendor italic face')
  for (const [, weight] of faces) assert(css.includes(`font-weight: ${weight};`))
  assert(readFileSync(`${root}/packages/ui/src/styles.css`, 'utf8').includes('@import "./fonts/superior-serif.css"'))
})

test('complete OFL notices accompany source faces and both app distributions', () => {
  const source = readFileSync(`${fonts}/superior-serif/OFL.txt`, 'utf8')
  assert.match(source, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(source, /Reserved Font Name LT Superior Serif/)
  for (const app of ['desktop', 'lab']) {
    for (const [name, path] of [
      ['LT-Superior-Serif-OFL.txt', `${fonts}/superior-serif/OFL.txt`],
      ['Geist-Mono-OFL.txt', `${fonts}/geist-mono/LICENSE`],
    ]) assert.deepEqual(readFileSync(`${root}/apps/${app}/public/font-licenses/${name}`), readFileSync(path!))
  }
})
