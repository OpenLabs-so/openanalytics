import fs from 'node:fs'
import path from 'node:path'

/**
 * Which framework this folder is, read from the artifacts frameworks cannot
 * help leaving behind: a config file, a dependency, a layout in its one true
 * place.
 *
 * Order matters and is most-specific first. A Next.js project has `react` in
 * its dependencies and often a `vite.config` never; a Nuxt project depends on
 * `vue`. Asking the generic questions first would misfile every meta-framework
 * into its runtime, so the meta-frameworks are asked about before the
 * libraries they are built on.
 *
 * Returning `null` is an answer, not a failure — the wizard falls back to
 * asking the person, who knows.
 */

export interface Framework {
  readonly id: FrameworkId
  readonly name: string
}

export type FrameworkId =
  | 'nextjs-app'
  | 'nextjs-pages'
  | 'react'
  | 'vue'
  | 'nuxt'
  | 'sveltekit'
  | 'remix'
  | 'tanstack-start'
  | 'astro'
  | 'gatsby'
  | 'wordpress'
  | 'html'

export const FRAMEWORKS: readonly Framework[] = [
  { id: 'nextjs-app', name: 'Next.js (App Router)' },
  { id: 'nextjs-pages', name: 'Next.js (Pages Router)' },
  { id: 'react', name: 'React (Vite / CRA)' },
  { id: 'vue', name: 'Vue.js' },
  { id: 'nuxt', name: 'Nuxt' },
  { id: 'sveltekit', name: 'SvelteKit' },
  { id: 'remix', name: 'Remix' },
  { id: 'tanstack-start', name: 'TanStack Start' },
  { id: 'astro', name: 'Astro' },
  { id: 'gatsby', name: 'Gatsby' },
  { id: 'wordpress', name: 'WordPress' },
  { id: 'html', name: 'HTML / static' },
]

export function frameworkById(id: string): Framework | undefined {
  return FRAMEWORKS.find((framework) => framework.id === id)
}

function exists(cwd: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(cwd, ...segments))
}

function readPackageJson(cwd: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

function hasDependency(pkg: Record<string, unknown>, name: string): boolean {
  for (const section of ['dependencies', 'devDependencies']) {
    const deps = pkg[section]
    if (typeof deps === 'object' && deps !== null && name in deps) return true
  }
  return false
}

function hasConfigFile(cwd: string, base: string): boolean {
  return ['.js', '.mjs', '.ts', '.cjs'].some((ext) => exists(cwd, base + ext))
}

const SOURCE_EXTS = ['.tsx', '.jsx', '.js', '.ts']

export function detectFramework(cwd: string): Framework | null {
  const pkg = readPackageJson(cwd)

  if (hasConfigFile(cwd, 'next.config') || hasDependency(pkg, 'next')) {
    // The router decides which file the snippet goes into, so the two Next.js
    // answers are separate frameworks as far as the injectors care.
    const pagesRouter =
      SOURCE_EXTS.some((ext) => exists(cwd, 'pages', `_app${ext}`)) ||
      SOURCE_EXTS.some((ext) => exists(cwd, 'src', 'pages', `_app${ext}`))
    const appRouter =
      SOURCE_EXTS.some((ext) => exists(cwd, 'app', `layout${ext}`)) ||
      SOURCE_EXTS.some((ext) => exists(cwd, 'src', 'app', `layout${ext}`))
    if (pagesRouter && !appRouter) return frameworkById('nextjs-pages') ?? null
    return frameworkById('nextjs-app') ?? null
  }

  if (hasConfigFile(cwd, 'nuxt.config') || hasDependency(pkg, 'nuxt')) {
    return frameworkById('nuxt') ?? null
  }

  if (hasConfigFile(cwd, 'svelte.config') || hasDependency(pkg, '@sveltejs/kit')) {
    return frameworkById('sveltekit') ?? null
  }

  if (hasConfigFile(cwd, 'remix.config') || hasDependency(pkg, '@remix-run/react')) {
    return frameworkById('remix') ?? null
  }

  // Start is a Vite app with `react` in its dependencies, so it has to be
  // asked about before the generic Vite-plus-React question below. The Solid
  // flavour keeps the same root-route file and `head()` shape, so one answer
  // covers both.
  if (hasDependency(pkg, '@tanstack/react-start') || hasDependency(pkg, '@tanstack/solid-start')) {
    return frameworkById('tanstack-start') ?? null
  }

  if (hasConfigFile(cwd, 'astro.config') || hasDependency(pkg, 'astro')) {
    return frameworkById('astro') ?? null
  }

  if (hasConfigFile(cwd, 'gatsby-config') || hasDependency(pkg, 'gatsby')) {
    return frameworkById('gatsby') ?? null
  }

  if (hasConfigFile(cwd, 'vite.config') && hasDependency(pkg, 'react')) {
    return frameworkById('react') ?? null
  }
  if (hasDependency(pkg, 'react-scripts')) {
    return frameworkById('react') ?? null
  }

  if (hasDependency(pkg, 'vue')) {
    return frameworkById('vue') ?? null
  }

  if (exists(cwd, 'functions.php')) {
    return frameworkById('wordpress') ?? null
  }
  if (exists(cwd, 'style.css')) {
    try {
      const css = fs.readFileSync(path.join(cwd, 'style.css'), 'utf8')
      // A WordPress theme announces itself in its stylesheet header.
      if (css.includes('Theme Name')) return frameworkById('wordpress') ?? null
    } catch {
      /* unreadable stylesheet — fall through */
    }
  }

  if (exists(cwd, 'index.html')) {
    return frameworkById('html') ?? null
  }

  return null
}
