import fs from 'node:fs'
import path from 'node:path'
import type { FrameworkId } from './detect.ts'
import { findFile, isAlreadyInstalled, readFile, scriptTag, writeFile } from './snippet.ts'

/**
 * One injector per framework: find the file the snippet belongs in, respect a
 * tag that is already there, and write the smallest edit that puts the tracker
 * in the `<head>` (or the framework's equivalent of one).
 *
 * Two rules every injector follows:
 *
 * - **Idempotent by inspection.** `/oa.js` anywhere in the target file means
 *   installed, and the injector returns without writing. Running `init` twice
 *   must never produce two tags.
 * - **Fail with a place, not a stack.** When the expected file or anchor is
 *   missing, the error names what was looked for and where, because the person
 *   reading it is standing in a folder wondering if it is the right one.
 */

export interface InjectContext {
  readonly cwd: string
  readonly key: string
  readonly collector: string
}

export interface InjectResult {
  readonly file: string
  readonly alreadyInstalled: boolean
}

export class InjectError extends Error {}

/** Insert `tag` before the first `</close>`, matching the file's indentation. */
function insertBeforeClosing(content: string, close: string, tag: string): string | null {
  if (!content.includes(`</${close}>`)) return null
  const match = content.match(new RegExp(`([ \\t]*)</${close}>`))
  const baseIndent = match?.[1] ?? ''
  return content.replace(`</${close}>`, `\n${baseIndent}  ${tag}\n${baseIndent}</${close}>`)
}

/** The `<head>`-first order the tracker doc asks for, with `<body>` as mercy. */
function injectIntoMarkup(ctx: InjectContext, candidates: readonly string[]): InjectResult {
  const file = findFile(ctx.cwd, candidates)
  if (!file) {
    throw new InjectError(
      `${candidates[0] ?? 'index.html'} not found. Run this from the root of your project.`,
    )
  }

  const content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const tag = scriptTag(ctx.key, ctx.collector)
  const updated =
    insertBeforeClosing(content, 'head', tag) ?? insertBeforeClosing(content, 'body', tag)
  if (updated === null) {
    throw new InjectError(`Could not find </head> or </body> in ${file.rel}.`)
  }

  writeFile(file.abs, updated)
  return { file: file.rel, alreadyInstalled: false }
}

/** `<Script>` from `next/script`, shared by both Next.js routers. */
function nextScriptComponent(ctx: InjectContext, indent: string): string {
  const attr = `${indent}  `
  return [
    `<Script`,
    `${attr}src="${ctx.collector}/oa.js"`,
    `${attr}data-key="${ctx.key}"`,
    `${attr}data-collector="${ctx.collector}"`,
    `${attr}strategy="afterInteractive"`,
    `${indent}/>`,
  ].join('\n')
}

function ensureNextScriptImport(content: string): string {
  if (content.includes("from 'next/script'") || content.includes('from "next/script"')) {
    return content
  }
  const lines = content.split('\n')
  let lastImport = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('import ')) lastImport = i
  }
  lines.splice(lastImport + 1, 0, "import Script from 'next/script'")
  return lines.join('\n')
}

function injectNextAppRouter(ctx: InjectContext): InjectResult {
  const file = findFile(
    ctx.cwd,
    ['app/layout', 'src/app/layout'].flatMap((base) =>
      ['.tsx', '.jsx', '.js', '.ts'].map((ext) => base + ext),
    ),
  )
  if (!file) {
    throw new InjectError('app/layout.tsx not found. Is this a Next.js App Router project?')
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  content = ensureNextScriptImport(content)

  // The layout closes `</body>` (or, unusually, only `</html>`); the Script
  // component becomes its last child so it never interrupts the page's own.
  const bodyMatch = content.match(/^([ \t]*)(.*)<\/body>/m)
  const htmlMatch = content.match(/^([ \t]*)(.*)<\/html>/m)
  const target = bodyMatch ?? htmlMatch
  if (!target) {
    throw new InjectError(`Could not find </body> or </html> in ${file.rel}.`)
  }
  const closing = bodyMatch ? '</body>' : '</html>'
  const baseIndent = target[1] ?? ''
  const childIndent = `${baseIndent}  `
  content = content.replace(
    target[0],
    `${baseIndent}${(target[2] ?? '').trimEnd()}\n${childIndent}${nextScriptComponent(ctx, childIndent)}\n${baseIndent}${closing}`,
  )

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectNextPagesRouter(ctx: InjectContext): InjectResult {
  const file = findFile(
    ctx.cwd,
    ['pages/_app', 'src/pages/_app'].flatMap((base) =>
      ['.tsx', '.jsx', '.js', '.ts'].map((ext) => base + ext),
    ),
  )

  if (!file) {
    // No custom _app yet — write the default one, snippet included.
    const dir = fs.existsSync(path.join(ctx.cwd, 'src/pages')) ? 'src/pages' : 'pages'
    const rel = path.join(dir, '_app.tsx')
    writeFile(
      path.join(ctx.cwd, rel),
      [
        "import type { AppProps } from 'next/app'",
        "import Script from 'next/script'",
        '',
        'export default function App({ Component, pageProps }: AppProps) {',
        '  return (',
        '    <>',
        '      <Component {...pageProps} />',
        `      ${nextScriptComponent(ctx, '      ')}`,
        '    </>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    return { file: rel, alreadyInstalled: false }
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  content = ensureNextScriptImport(content)

  const component = `      ${nextScriptComponent(ctx, '      ')}`
  if (content.includes('</>')) {
    content = content.replace('</>', `${component}\n    </>`)
  } else {
    // No fragment to grow — put the Script before the render's last `)`.
    const closeParen = content.lastIndexOf(')')
    if (closeParen === -1) {
      throw new InjectError(`Could not find where to add the snippet in ${file.rel}.`)
    }
    content = `${content.slice(0, closeParen)}\n${component}\n    ${content.slice(closeParen)}`
  }

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectNuxt(ctx: InjectContext): InjectResult {
  const file = findFile(ctx.cwd, ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'])
  if (!file) {
    throw new InjectError('nuxt.config not found. Run this from the root of your Nuxt project.')
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const scriptConfig = [
    '',
    '  app: {',
    '    head: {',
    '      script: [',
    '        {',
    `          src: '${ctx.collector}/oa.js',`,
    `          'data-key': '${ctx.key}',`,
    `          'data-collector': '${ctx.collector}',`,
    '          async: true,',
    '        },',
    '      ],',
    '    },',
    '  },',
  ].join('\n')

  const anchor = content.includes('defineNuxtConfig(')
    ? content.indexOf('defineNuxtConfig(')
    : content.indexOf('export default {')
  if (anchor === -1) {
    throw new InjectError(`Could not find defineNuxtConfig or export default in ${file.rel}.`)
  }
  const brace = content.indexOf('{', anchor)
  if (brace === -1) {
    throw new InjectError(`Could not find the config object in ${file.rel}.`)
  }
  content = content.slice(0, brace + 1) + scriptConfig + content.slice(brace + 1)

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectSvelteKit(ctx: InjectContext): InjectResult {
  const rel = 'src/routes/+layout.svelte'
  const file = findFile(ctx.cwd, [rel])
  const tag = scriptTag(ctx.key, ctx.collector)
  const svelteHead = `<svelte:head>\n  ${tag}\n</svelte:head>\n\n`

  if (!file) {
    writeFile(path.join(ctx.cwd, rel), `${svelteHead}<slot />\n`)
    return { file: rel, alreadyInstalled: false }
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  content = content.includes('<svelte:head>')
    ? content.replace('<svelte:head>', `<svelte:head>\n  ${tag}`)
    : svelteHead + content

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectRemix(ctx: InjectContext): InjectResult {
  const file = findFile(ctx.cwd, ['app/root.tsx', 'app/root.jsx', 'app/root.js', 'app/root.ts'])
  if (!file) {
    throw new InjectError('app/root.tsx not found. Run this from the root of your Remix project.')
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const tag = scriptTag(ctx.key, ctx.collector)
  const headInsert = insertBeforeClosing(content, 'head', tag)
  if (headInsert !== null) {
    content = headInsert
  } else {
    // Remix's root often has no literal </head>; <Links /> stands where the
    // head's children go, so the tag lines up beside it.
    const linksMatch = content.match(/([ \t]*)<Links\s*\/>/)
    if (!linksMatch) {
      throw new InjectError(`Could not find </head> or <Links /> in ${file.rel}.`)
    }
    content = content.replace(linksMatch[0], `${linksMatch[0]}\n${linksMatch[1] ?? ''}${tag}`)
  }

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

/**
 * Index of the `}` that closes the `{` at `open`, stepping over string and
 * template literals and comments so a brace inside `'{'` or `// {` does not
 * count. `-1` when nothing closes it. Enough of a scanner for an options
 * object; not a parser, and not trying to be one.
 */
function closingBrace(content: string, open: number): number {
  let depth = 0
  for (let i = open; i < content.length; i += 1) {
    const ch = content[i]
    const next = content[i + 1]
    if (ch === '/' && next === '/') {
      const eol = content.indexOf('\n', i)
      if (eol === -1) return -1
      i = eol
      continue
    }
    if (ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = closingQuote(content, i)
      if (end === -1) return -1
      i = end
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** The index of the quote ending the literal that opens at `start`; a `'` or
 * `"` left open at the end of its line (JSX text, say) ends there instead. */
function closingQuote(content: string, start: number): number {
  const quote = content[start]
  for (let i = start + 1; i < content.length; i += 1) {
    const ch = content[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
    if (quote !== '`' && ch === '\n') return i
  }
  return -1
}

/**
 * The root route's options object: `open` is its `{`, `close` its `}`. Found
 * from the `Route = createRootRoute…` declaration (file-based routing requires
 * that export), falling back to the first `createRootRoute` that is not on an
 * import line, then the first `({` after it — which, for
 * `createRootRouteWithContext<T>()({`, is the second call's.
 */
function rootRouteOptions(content: string): { open: number; close: number } | null {
  const identifier = /\bcreateRootRoute(?:WithContext)?\b/g
  let anchor = -1
  const declared = content.match(/\bRoute\s*=\s*createRootRoute(?:WithContext)?\b/)
  if (declared?.index !== undefined) {
    anchor = declared.index + declared[0].length
  } else {
    for (const match of content.matchAll(identifier)) {
      const lineStart = content.lastIndexOf('\n', match.index) + 1
      if (content.slice(lineStart, match.index).trimStart().startsWith('import')) continue
      anchor = match.index + match[0].length
      break
    }
  }
  if (anchor === -1) return null
  const open = content.indexOf('({', anchor)
  if (open === -1) return null
  const close = closingBrace(content, open + 1)
  if (close === -1) return null
  return { open: open + 1, close }
}

/**
 * TanStack Start has no static HTML file: the document shell and its head are
 * the root route's, the head as its `head()` option rendered by `<HeadContent />`. The tag becomes an entry in
 * that option's `scripts` array — added to the array when there is one, to the
 * `head()` object when there is not, and as a whole `head()` when the root
 * route declares none. Text edits anchored on the file's own indentation, as
 * the Nuxt injector does; no parser.
 */
function injectTanStackStart(ctx: InjectContext): InjectResult {
  const file = findFile(
    ctx.cwd,
    ['src/routes/__root', 'app/routes/__root'].flatMap((base) =>
      ['.tsx', '.jsx', '.js', '.ts'].map((ext) => base + ext),
    ),
  )
  if (!file) {
    throw new InjectError(
      'src/routes/__root.tsx not found. Run this from the root of your TanStack Start project.',
    )
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const scriptEntry = (indent: string): string =>
    [
      `${indent}{`,
      `${indent}  src: '${ctx.collector}/oa.js',`,
      `${indent}  'data-key': '${ctx.key}',`,
      `${indent}  'data-collector': '${ctx.collector}',`,
      `${indent}  async: true,`,
      `${indent}},`,
    ].join('\n')

  // Every search is scoped to the root route's own options: a helper above it
  // with a `head:` of its own, or an earlier `({` call, must not catch the edit.
  const options = rootRouteOptions(content)
  if (!options) {
    throw new InjectError(`Could not find the createRootRoute options object in ${file.rel}.`)
  }
  const optionsBody = content.slice(options.open, options.close)

  // `head: () => ({` — the option as every Start starter writes it, with or
  // without a parameter, with or without `async`.
  const head = optionsBody.match(/^([ \t]*)head\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\(\s*\{/m)
  if (head && head.index !== undefined) {
    const headIndent = head[1] ?? ''
    const afterHead = options.open + head.index + head[0].length
    const headClose = closingBrace(content, afterHead - 1)
    if (headClose === -1) {
      throw new InjectError(`Could not find the end of head() in ${file.rel}.`)
    }
    const scripts = content.slice(afterHead, headClose).match(/^([ \t]*)scripts\s*:\s*\[/m)
    if (scripts && scripts.index !== undefined) {
      // The array exists: the tag joins it as the first entry.
      const at = afterHead + scripts.index + scripts[0].length
      const itemIndent = `${scripts[1] ?? ''}  `
      content = `${content.slice(0, at)}\n${scriptEntry(itemIndent)}${content.slice(at)}`
    } else {
      // A head() without scripts: the array opens the returned object.
      const keyIndent = `${headIndent}  `
      const block = [
        '',
        `${keyIndent}scripts: [`,
        scriptEntry(`${keyIndent}  `),
        `${keyIndent}],`,
      ].join('\n')
      content = `${content.slice(0, afterHead)}${block}${content.slice(afterHead)}`
    }
  } else if (/^[ \t]*(?:async\s+)?head\s*[:(]/m.test(optionsBody)) {
    // A head() the arrow-object edit cannot see — method shorthand, a block
    // body, a named function — is a refusal, not a fall-through: adding a
    // second `head:` would let the person's own win and the script silently
    // never load, which is the one outcome an installer must not have.
    throw new InjectError(
      `head() in ${file.rel} is not written as \`head: () => ({ … })\`, which is the only form ` +
        'the installer edits. Add the script entry by hand: the TanStack Start page under ' +
        'Installation in the docs shows where.',
    )
  } else {
    // No head() at all: one is added as the first root-route option.
    const block = [
      '',
      '  head: () => ({',
      '    scripts: [',
      scriptEntry('      '),
      '    ],',
      '  }),',
    ].join('\n')
    content = `${content.slice(0, options.open + 1)}${block}${content.slice(options.open + 1)}`
  }

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectGatsby(ctx: InjectContext): InjectResult {
  const snippet = [
    '// Open Analytics',
    'export const onRenderBody = ({ setHeadComponents }) => {',
    '  setHeadComponents([',
    '    <script',
    '      key="open-analytics"',
    '      async',
    `      src="${ctx.collector}/oa.js"`,
    `      data-key="${ctx.key}"`,
    `      data-collector="${ctx.collector}"`,
    '    />,',
    '  ])',
    '}',
    '',
  ].join('\n')

  const file = findFile(ctx.cwd, [
    'gatsby-ssr.js',
    'gatsby-ssr.jsx',
    'gatsby-ssr.ts',
    'gatsby-ssr.tsx',
  ])
  if (!file) {
    writeFile(path.join(ctx.cwd, 'gatsby-ssr.js'), snippet)
    return { file: 'gatsby-ssr.js', alreadyInstalled: false }
  }

  let content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  if (content.includes('setHeadComponents')) {
    content = content.replace(
      /setHeadComponents\(\[/,
      `setHeadComponents([\n    <script key="open-analytics" async src="${ctx.collector}/oa.js" data-key="${ctx.key}" data-collector="${ctx.collector}" />,`,
    )
  } else if (content.includes('onRenderBody')) {
    throw new InjectError(
      `${file.rel} already exports onRenderBody without setHeadComponents — add the snippet there by hand.`,
    )
  } else {
    content = `${content}\n${snippet}`
  }

  writeFile(file.abs, content)
  return { file: file.rel, alreadyInstalled: false }
}

function injectWordPress(ctx: InjectContext): InjectResult {
  const file = findFile(ctx.cwd, ['functions.php'])
  if (!file) {
    throw new InjectError('functions.php not found. Run this from your WordPress theme directory.')
  }

  const content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const snippet = [
    '',
    '// Open Analytics',
    'function open_analytics_tracking_script() {',
    `    echo '${scriptTag(ctx.key, ctx.collector)}';`,
    '}',
    "add_action( 'wp_head', 'open_analytics_tracking_script' );",
    '',
  ].join('\n')

  writeFile(file.abs, content + snippet)
  return { file: file.rel, alreadyInstalled: false }
}

function injectAstro(ctx: InjectContext): InjectResult {
  const file = findFile(ctx.cwd, [
    'src/layouts/Layout.astro',
    'src/layouts/BaseLayout.astro',
    'src/layouts/layout.astro',
    'src/pages/index.astro',
  ])
  if (!file) {
    throw new InjectError(
      'src/layouts/Layout.astro not found. Run this from the root of your Astro project.',
    )
  }

  const content = readFile(file.abs)
  if (isAlreadyInstalled(content)) return { file: file.rel, alreadyInstalled: true }

  const updated = insertBeforeClosing(content, 'head', scriptTag(ctx.key, ctx.collector))
  if (updated === null) {
    throw new InjectError(`Could not find </head> in ${file.rel}.`)
  }

  writeFile(file.abs, updated)
  return { file: file.rel, alreadyInstalled: false }
}

export function inject(framework: FrameworkId, ctx: InjectContext): InjectResult {
  switch (framework) {
    case 'nextjs-app':
      return injectNextAppRouter(ctx)
    case 'nextjs-pages':
      return injectNextPagesRouter(ctx)
    case 'react':
    case 'vue':
      return injectIntoMarkup(ctx, ['index.html', 'public/index.html'])
    case 'html':
      return injectIntoMarkup(ctx, ['index.html'])
    case 'nuxt':
      return injectNuxt(ctx)
    case 'sveltekit':
      return injectSvelteKit(ctx)
    case 'remix':
      return injectRemix(ctx)
    case 'tanstack-start':
      return injectTanStackStart(ctx)
    case 'astro':
      return injectAstro(ctx)
    case 'gatsby':
      return injectGatsby(ctx)
    case 'wordpress':
      return injectWordPress(ctx)
  }
}
