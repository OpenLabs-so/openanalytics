import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFramework } from '../../apps/cli/src/init/detect.ts'
import { inject, InjectError } from '../../apps/cli/src/init/injectors.ts'

/**
 * `oa init` on a TanStack Start project.
 *
 * Start has no HTML shell; the injector edits the root route's `head()` by
 * text, anchored on the file's own indentation. The edit is what is pinned
 * here, in the three shapes a root route comes in (a `scripts` array already
 * there, a `head()` without one, no `head()` at all), plus the two rules every
 * injector keeps: idempotent on `/oa.js`, and an error that names the file it
 * looked for. Every written file is also run through the TypeScript parser,
 * because a text edit that lands in the wrong brace is a syntax error the
 * person only meets when their build breaks.
 */

const KEY = 'oa_pk_test'
const COLLECTOR = 'https://c.example.com'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'oa-init-tanstack-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function writeProject(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
}

function pkg(deps: Record<string, string>): string {
  return JSON.stringify({ name: 'fixture', dependencies: deps })
}

/** The parser's verdict on a written root route: no syntax diagnostics. */
function syntaxErrors(source: string): string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: '__root.tsx',
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  })
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

const ROOT_WITH_SCRIPTS = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }],
    scripts: [
      {
        src: '/customScript.js',
        type: 'text/javascript',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
`

const ROOT_WITHOUT_SCRIPTS = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { title: 'Starter' }],
  }),
  component: RootComponent,
})
`

const ROOT_WITHOUT_HEAD = `import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
})
`

/** A helper with a head() and a scripts array of its own, declared above the
 * root route — the thing a file-wide search would edit by mistake. */
const ROOT_AFTER_HELPER_HEAD = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

const fallback = {
  head: () => ({
    scripts: [{ src: '/helper.js' }],
  }),
}

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }],
  }),
  component: RootComponent,
})
`

/** An earlier \`({\` call (a destructuring arrow) above a root route that has
 * no head() — where "the first \`({\` after createRootRoute" used to land. */
const ROOT_AFTER_PAREN_BRACE = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

const seo = ({ title }: { title: string }) => [{ title }]

export const Route = createRootRoute({
  component: RootComponent,
})
`

/** head() as method shorthand: the form the arrow-object edit cannot see. */
const ROOT_WITH_METHOD_HEAD = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head() {
    return { meta: [{ charSet: 'utf-8' }] }
  },
  component: RootComponent,
})
`

describe('detectFramework on a TanStack Start project', () => {
  it('answers tanstack-start from the @tanstack/react-start dependency', () => {
    writeProject({
      'package.json': pkg({ '@tanstack/react-start': '^1.0.0', react: '^19.0.0' }),
      'vite.config.ts': 'export default {}',
    })
    expect(detectFramework(cwd)?.id).toBe('tanstack-start')
  })

  it('wins over the generic Vite-plus-React answer', () => {
    // The same folder without Start is a plain React app: the order of the
    // questions is what keeps a Start project out of that bucket.
    writeProject({
      'package.json': pkg({ react: '^19.0.0' }),
      'vite.config.ts': 'export default {}',
      'index.html': '<html><head></head></html>',
    })
    expect(detectFramework(cwd)?.id).toBe('react')
  })

  it('covers the Solid flavour too', () => {
    writeProject({ 'package.json': pkg({ '@tanstack/solid-start': '^1.0.0' }) })
    expect(detectFramework(cwd)?.id).toBe('tanstack-start')
  })
})

describe('inject on a TanStack Start root route', () => {
  const ctx = () => ({ cwd, key: KEY, collector: COLLECTOR })

  it('joins an existing scripts array as its first entry', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_WITH_SCRIPTS })

    const result = inject('tanstack-start', ctx())

    expect(result).toEqual({ file: 'src/routes/__root.tsx', alreadyInstalled: false })
    const written = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    expect(syntaxErrors(written)).toEqual([])
    expect(written).toContain(`src: '${COLLECTOR}/oa.js'`)
    expect(written).toContain(`'data-key': '${KEY}'`)
    expect(written).toContain(`'data-collector': '${COLLECTOR}'`)
    expect(written).toContain('async: true')
    // Ours comes first, the project's own script stays, nothing else moves.
    expect(written.indexOf('/oa.js')).toBeLessThan(written.indexOf('/customScript.js'))
    expect(written).toContain("meta: [{ charSet: 'utf-8' }]")
    expect(written).toMatch(
      / {4}scripts: \[\n {6}\{\n {8}src: 'https:\/\/c\.example\.com\/oa\.js',/,
    )
  })

  it('adds a scripts array to a head() that has none', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_WITHOUT_SCRIPTS })

    inject('tanstack-start', ctx())

    const written = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    expect(syntaxErrors(written)).toEqual([])
    expect(written).toMatch(/head: \(\) => \(\{\n {4}scripts: \[\n {6}\{\n {8}src: /)
    expect(written).toContain("{ title: 'Starter' }")
  })

  it('adds a whole head() to a root route that declares none', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_WITHOUT_HEAD })

    inject('tanstack-start', ctx())

    const written = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    expect(syntaxErrors(written)).toEqual([])
    // createRootRouteWithContext<T>()({ — the options object is the second
    // call's, and head() lands inside it, before the project's own options.
    expect(written).toMatch(
      /createRootRouteWithContext<\{ queryClient: QueryClient \}>\(\)\(\{\n {2}head: \(\) => \(\{\n {4}scripts: \[/,
    )
    expect(written.indexOf('head:')).toBeLessThan(written.indexOf('component:'))
  })

  it('edits the root route, not a helper above it that also has a head()', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_AFTER_HELPER_HEAD })

    inject('tanstack-start', ctx())

    const written = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    expect(syntaxErrors(written)).toEqual([])
    // The helper keeps its one-entry array; ours lands inside createRootRoute's head().
    expect(written).toContain("scripts: [{ src: '/helper.js' }],")
    expect(written.indexOf('/oa.js')).toBeGreaterThan(written.indexOf('createRootRoute({'))
    expect(written.match(/\/oa\.js/g)).toHaveLength(1)
  })

  it('adds head() to the root route, not at an earlier ({ call', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_AFTER_PAREN_BRACE })

    inject('tanstack-start', ctx())

    const written = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    expect(syntaxErrors(written)).toEqual([])
    expect(written).toContain('const seo = ({ title }: { title: string }) => [{ title }]')
    expect(written).toMatch(/createRootRoute\(\{\n {2}head: \(\) => \(\{\n {4}scripts: \[/)
  })

  it('finds the root route under app/routes as well', () => {
    writeProject({ 'app/routes/__root.jsx': ROOT_WITHOUT_SCRIPTS })

    expect(inject('tanstack-start', ctx())).toEqual({
      file: 'app/routes/__root.jsx',
      alreadyInstalled: false,
    })
  })

  it('is idempotent: a second run leaves the file alone', () => {
    writeProject({ 'src/routes/__root.tsx': ROOT_WITH_SCRIPTS })

    inject('tanstack-start', ctx())
    const once = readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')
    const again = inject('tanstack-start', ctx())

    expect(again).toEqual({ file: 'src/routes/__root.tsx', alreadyInstalled: true })
    expect(readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')).toBe(once)
    expect(once.match(/\/oa\.js/g)).toHaveLength(1)
  })

  it('names the file it looked for when the root route is missing', () => {
    writeProject({ 'package.json': pkg({ '@tanstack/react-start': '^1.0.0' }) })

    expect(() => inject('tanstack-start', ctx())).toThrow(InjectError)
    expect(() => inject('tanstack-start', ctx())).toThrow(/src\/routes\/__root\.tsx not found/)
  })

  it('refuses a head() it cannot edit rather than adding a second one', () => {
    // A second `head:` would be shadowed by the person's own and the script
    // would silently never load — the one outcome an installer must not have.
    writeProject({ 'src/routes/__root.tsx': ROOT_WITH_METHOD_HEAD })

    expect(() => inject('tanstack-start', ctx())).toThrow(InjectError)
    expect(() => inject('tanstack-start', ctx())).toThrow(
      /head\(\) in src\/routes\/__root\.tsx is not written as/,
    )
    expect(readFileSync(join(cwd, 'src/routes/__root.tsx'), 'utf8')).toBe(ROOT_WITH_METHOD_HEAD)
  })

  it('refuses a head referenced by name or written as a block body, too', () => {
    const forms = [
      'head: buildHead,',
      'head: () => {\n    return {}\n  },',
      'head: async () => {\n    return {}\n  },',
    ]
    for (const head of forms) {
      writeProject({
        'src/routes/__root.tsx': [
          "import { createRootRoute } from '@tanstack/react-router'",
          'export const Route = createRootRoute({',
          `  ${head}`,
          '  component: RootComponent,',
          '})',
          '',
        ].join('\n'),
      })
      expect(() => inject('tanstack-start', ctx())).toThrow(/is not written as/)
    }
  })

  it('refuses a root route it cannot anchor in, rather than guessing', () => {
    writeProject({ 'src/routes/__root.tsx': 'export const Route = somethingElse({})\n' })

    expect(() => inject('tanstack-start', ctx())).toThrow(
      /Could not find the createRootRoute options object/,
    )
  })
})
