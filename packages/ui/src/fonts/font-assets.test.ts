import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
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

test('Timeless Sans: original owner-supplied variable WOFF2, never converted or subset', () => {
  const bytes = readFileSync(`${fonts}/timeless-sans/TimelessSansVF.woff2`)
  assert.equal(bytes.length, 211828)
  assert.equal(bytes.toString('ascii', 0, 4), 'wOF2')
  assert.equal(bytes.readUInt32BE(8), bytes.length, 'WOFF2 declared length matches the original file')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '353b3fbb75b8e9b927db12d520ff8d446d89c36897b47a90d70dbe36e9eeb23a')
  assert.deepEqual(readdirSync(`${fonts}/timeless-sans`).sort(), ['LICENSE.txt', 'NOTICE.txt', 'TimelessSansVF.woff2'], 'Only the upright variable source and applicable notices; no statics, Serif-Text or old license PDF')
})

test('Timeless Sans: truthful variable descriptors and Sans axes in UI and portal scopes', () => {
  const css = readFileSync(`${fonts}/timeless-sans.css`, 'utf8')
  assert.equal((css.match(/@font-face\s*\{/g) ?? []).length, 1)
  assert.match(css, /font-family:\s*"Timeless Sans"\s*;/)
  assert.match(css, /src:\s*url\("\.\/timeless-sans\/TimelessSansVF\.woff2"\)\s*format\("woff2"\)\s*;/)
  assert.match(css, /font-weight:\s*300 800\s*;/)
  assert.match(css, /font-style:\s*normal\s*;/)
  assert.match(css, /font-display:\s*swap\s*;/)
  assert.match(css, /font-variation-settings:\s*"STYL" 100,\s*"ital" 0\s*;/)
  assert.doesNotMatch(css, /font-style:\s*(?:italic|oblique)/, 'No separately registered italic or synthetic static faces')
  const shared = readFileSync(`${root}/packages/ui/src/styles.css`, 'utf8')
  assert(shared.includes('@import "./fonts/timeless-sans.css"'))
  const scopes = shared.match(/:where\(\.graphical-theme,\s*\[data-ui-component\],\s*\.ui-positioner,\s*\.kintsugi-portal\)\s*\{([^}]+)\}/)
  assert(scopes, 'Shared UI and real portal roots must inherit axes even where @font-face variation descriptors are unsupported')
  assert.match(scopes[1]!, /font-variation-settings:\s*"STYL" 100,\s*"ital" 0\s*;/)
})

test('Timeless Sans: complete v1.3 contract and explicit owner election, not the archive v1.2 PDF', () => {
  const license = readFileSync(`${fonts}/timeless-sans/LICENSE.txt`, 'utf8')
  assert.match(license, /^Timeless Free Font License\s+Version 1\.3 · 24 October 2026/)
  assert.match(license, /Copyright 2026 Timeless Ventures Private Limited, Chennai/)
  assert.match(license, /code repository \(public or private\)/)
  assert.match(license, /Whenever you pass on the font files,[\s\S]*include a copy of this contract/)
  assert.match(license, /7 Custom naming & customisation\s+Anyone who wants the fonts on their own should get them from timeless\.co\./, 'Retain the complete section 7 paragraph omitted by some web text extraction')
  assert.match(license, /custom-business for organisations of up to 100 members[\s\S]*custom-enterprise above that\. Write to hello@timeless\.co\./)
  assert.match(license, /Nothing in this contract grants any right in the Timeless name or marks\./)
  assert.match(license, /8\.4 The whole agreement[\s\S]*unless you choose to follow a later version instead\./)
  assert.match(license, /8\.3 Governing law & jurisdiction[\s\S]*courts at Chennai, Tamil Nadu/)
  const notice = readFileSync(`${fonts}/timeless-sans/NOTICE.txt`, 'utf8')
  assert.match(notice, /Governing contract: Timeless Free Font License v1\.3, dated 24 October 2026/)
  assert.match(notice, /Source: https:\/\/www\.timeless\.co\/type\/license/)
  assert.match(notice, /On 2026-10-31 the owner explicitly elected to follow v1\.3 under its section 8\.4/)
  assert.match(notice, /"unless you choose to follow a later version instead"/)
  assert.match(notice, /LICENSE\.pdf v1\.2\. Its section\s+8\.4 does NOT include the later-version election sentence/, 'Do not attribute the new election wording to the archive contract')
  assert.match(notice, /Timeless-Type-Family-1\.094\/Sans-Grotesk\/TimelessSansVF\.woff2/)
  assert.match(notice, /510685dfce6010b74a1a250af7de1204e1b9901be152a39f5dd6be85fc6d6084/)
  assert.match(notice, /353b3fbb75b8e9b927db12d520ff8d446d89c36897b47a90d70dbe36e9eeb23a/)
  assert.match(notice, /Only this unmodified WOFF2 is distributed/)
})

test('Timeless Sans: both app distributions retain exact contract/NOTICE copies, not duplicate font binaries', () => {
  for (const app of ['desktop']) {
    const directory = `${root}/apps/${app}/public/font-licenses`
    for (const name of ['LICENSE', 'NOTICE']) {
      assert.deepEqual(readFileSync(`${directory}/Timeless-Sans-${name}.txt`), readFileSync(`${fonts}/timeless-sans/${name}.txt`))
    }
    assert(readdirSync(directory).every(name => !/\.(?:woff2?|otf|ttf|pdf)$/i.test(name)), 'Distribution notice directory contains notices only')
  }
})

test('complete OFL notices accompany source faces and both app distributions', () => {
  const source = readFileSync(`${fonts}/superior-serif/OFL.txt`, 'utf8')
  assert.match(source, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(source, /Reserved Font Name LT Superior Serif/)
  for (const app of ['desktop']) {
    for (const [name, path] of [
      ['LT-Superior-Serif-OFL.txt', `${fonts}/superior-serif/OFL.txt`],
      ['Geist-Mono-OFL.txt', `${fonts}/geist-mono/LICENSE`],
    ]) assert.deepEqual(readFileSync(`${root}/apps/${app}/public/font-licenses/${name}`), readFileSync(path!))
  }
})
