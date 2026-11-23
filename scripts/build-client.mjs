import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootReq = createRequire(join(root, 'package.json'))

function loadEsbuild() {
  try {
    return rootReq('esbuild')
  } catch {
    const webAppReq = createRequire(rootReq.resolve('@deepseek-ai/dsh-web-app/package.json'))
    return webAppReq('esbuild')
  }
}

const esbuild = loadEsbuild()
const entry = join(root, 'src', 'client', 'index.ts')
const outFile = join(root, 'lib', 'client.js')

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  legalComments: 'none',
})

assert.equal(result.outputFiles.length, 1, 'esbuild must emit exactly one client bundle output')
const bundledCode = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({id:"dsh-roles",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${bundledCode}\nreturn module.exports;}});\n`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, wrapped, 'utf8')

// Smoke-check the emitted loader registration inside an isolated VM sandbox.
let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  },
  globalThis: undefined,
}
sandbox.globalThis = sandbox

vm.runInNewContext(wrapped, sandbox, { filename: 'lib/client.js' })
assert(registration && registration.id === 'dsh-roles', 'bundle must register id "dsh-roles"')
assert.equal(typeof registration.factory, 'function', 'bundle must provide a factory function')

const stubRequire = (specifier) => {
  switch (specifier) {
    case 'react':
      return { useId: () => 'id', useEffect: () => {}, useMemo: fn => fn(), useRef: v => ({ current: v }) }
    case 'react/jsx-runtime':
      return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
    case '@deepseek-ai/dsh-client-ui-primitives':
      return { SettingsForm: () => null, SettingsValueField: () => null, Switch: () => null, Tag: () => null }
    case '@deepseek-ai/dsh-client-ui-slots':
      return {}
    default:
      throw new Error(`Unexpected external require from client bundle: ${specifier}`)
  }
}

const exports = registration.factory(stubRequire)
assert.equal(typeof exports.apply, 'function', 'client bundle must export apply()')
assert(Array.isArray(exports.inject), 'client bundle must export inject[]')
console.log(`Built ${outFile} (${Buffer.byteLength(wrapped)} bytes)`)
