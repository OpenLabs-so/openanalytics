import { COLLECTOR_BASE_URL } from "@/lib/api";

/**
 * The framework install guides, as data.
 *
 * One page template renders all of them (`app/docs/install/[framework]`),
 * so a guide is a list of steps here rather than a hand-built page. The
 * list mirrors what `oa init` detects (`apps/cli/src/init/detect.ts`) plus
 * the guides the CLI does not reach — hosted platforms (Webflow, Shopify) and
 * frameworks it has no injector for yet (TanStack Start) — the snippet is the
 * same everywhere; only the file it goes into changes.
 *
 * `SNIPPET` is the placeholder-key form of the tracker tag from
 * `docs/frontend/tracker_snippet.md`; every claim in the steps is that
 * document's.
 */

/**
 * The tag every guide prints, built from this deployment's own collector
 * origin. A documentation page that hardcoded one origin would teach every
 * reader of every fork to send their events somewhere else.
 */
export const DOCS_SNIPPET = `<script
  async
  src="${COLLECTOR_BASE_URL}/oa.js"
  data-key="YOUR_TRACKING_KEY"
  data-collector="${COLLECTOR_BASE_URL}"
></script>`;

export type FrameworkStep = {
  text: string;
  code?: string;
  caption?: string;
};

export type DocFramework = {
  slug: string;
  name: string;
  /** Whether `npx getopen init` can do this one automatically. */
  cliDetects: boolean;
  steps: FrameworkStep[];
};

const VERIFY_STEP: FrameworkStep = {
  text: "Deploy (or run your dev server) and open the site once. The realtime view in your dashboard shows the visit within seconds; historical charts fill moments later.",
};

export const DOC_FRAMEWORKS: DocFramework[] = [
  {
    slug: "html",
    name: "HTML / static sites",
    cliDetects: true,
    steps: [
      {
        text: "Paste the snippet into the <head> of every page. On a static site with shared includes, the shared header is the right place.",
        code: DOCS_SNIPPET,
        caption: "index.html",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "nextjs",
    name: "Next.js",
    cliDetects: true,
    steps: [
      {
        text: "App Router: add the script tag inside the <head> element of your root layout. If the layout has no <head> yet, add one; Next.js merges it with its own.",
        code: `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script
          async
          src="${COLLECTOR_BASE_URL}/oa.js"
          data-key="YOUR_TRACKING_KEY"
          data-collector="${COLLECTOR_BASE_URL}"
        ></script>
      </head>
      <body>{children}</body>
    </html>
  );
}`,
        caption: "app/layout.tsx",
      },
      {
        text: "Pages Router: put the same tag inside <Head> in your custom document instead.",
        caption: "pages/_document.tsx",
      },
      {
        text: "Client-side navigation is tracked automatically: the script patches the history API, so route changes count as pageviews with no extra code.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "tanstack-start",
    name: "TanStack Start",
    cliDetects: false,
    steps: [
      {
        text: "TanStack Start has no static HTML file; the document shell and its head are declared on the root route. Add the script to the scripts array returned by head() there, next to your meta and links.",
        code: `import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }],
    scripts: [
      {
        src: "${COLLECTOR_BASE_URL}/oa.js",
        async: true,
        "data-key": "YOUR_TRACKING_KEY",
        "data-collector": "${COLLECTOR_BASE_URL}",
      },
    ],
  }),
  shellComponent: RootDocument,
});`,
        caption: "src/routes/__root.tsx",
      },
      {
        text: "Make sure <HeadContent /> is rendered inside <head> in your root document; it is what turns the head() entries into tags. Every Start starter already has it.",
        code: `function RootDocument({ children }) {
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
  );
}`,
        caption: "src/routes/__root.tsx",
      },
      {
        text: "Router navigation is tracked automatically; the root route stays mounted across client-side transitions, so the tag loads once and follows every route change.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "react",
    name: "React (Vite / CRA)",
    cliDetects: true,
    steps: [
      {
        text: "Vite and Create React App render into a static HTML shell; the snippet goes into its <head>.",
        code: DOCS_SNIPPET,
        caption: "index.html (Vite) or public/index.html (CRA)",
      },
      {
        text: "If you use React Router, route changes are tracked automatically; nothing to wire.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "vue",
    name: "Vue.js",
    cliDetects: true,
    steps: [
      {
        text: "A Vite-based Vue app has one HTML shell; the snippet goes into its <head>.",
        code: DOCS_SNIPPET,
        caption: "index.html",
      },
      {
        text: "Vue Router navigation is tracked automatically as pageviews.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "nuxt",
    name: "Nuxt",
    cliDetects: true,
    steps: [
      {
        text: "Declare the script in your Nuxt config's app head, so every rendered page carries it.",
        code: `export default defineNuxtConfig({
  app: {
    head: {
      script: [
        {
          async: true,
          src: "${COLLECTOR_BASE_URL}/oa.js",
          "data-key": "YOUR_TRACKING_KEY",
          "data-collector": "${COLLECTOR_BASE_URL}",
        },
      ],
    },
  },
});`,
        caption: "nuxt.config.ts",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "sveltekit",
    name: "SvelteKit",
    cliDetects: true,
    steps: [
      {
        text: "SvelteKit renders every page through one HTML template; the snippet goes into its <head>, above %sveltekit.head%.",
        code: DOCS_SNIPPET,
        caption: "src/app.html",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "remix",
    name: "Remix",
    cliDetects: true,
    steps: [
      {
        text: "Add the script tag inside the <head> of your root route, next to <Meta /> and <Links />.",
        code: `<head>
  <Meta />
  <Links />
  <script
    async
    src="${COLLECTOR_BASE_URL}/oa.js"
    data-key="YOUR_TRACKING_KEY"
    data-collector="${COLLECTOR_BASE_URL}"
  ></script>
</head>`,
        caption: "app/root.tsx",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "astro",
    name: "Astro",
    cliDetects: true,
    steps: [
      {
        text: "Add the snippet to the <head> of your base layout. Astro strips unknown attributes from components, not from plain script tags, so the tag works as-is; add is:inline if your setup processes scripts.",
        code: DOCS_SNIPPET,
        caption: "src/layouts/Layout.astro",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "gatsby",
    name: "Gatsby",
    cliDetects: true,
    steps: [
      {
        text: "Use the SSR API to add the script to every page's head.",
        code: `import React from "react";

export const onRenderBody = ({ setHeadComponents }) => {
  setHeadComponents([
    <script
      key="open-analytics"
      async
      src="${COLLECTOR_BASE_URL}/oa.js"
      data-key="YOUR_TRACKING_KEY"
      data-collector="${COLLECTOR_BASE_URL}"
    />,
  ]);
};`,
        caption: "gatsby-ssr.js",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "wordpress",
    name: "WordPress",
    cliDetects: true,
    steps: [
      {
        text: "Paste the snippet before </head> in your theme's header template. On a block theme, use a header-scripts plugin or your theme's custom-code field instead; any mechanism that lands the tag in <head> is fine.",
        code: DOCS_SNIPPET,
        caption: "header.php",
      },
      {
        text: "A caching plugin may serve old HTML for a while; purge its cache after adding the tag.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "webflow",
    name: "Webflow",
    cliDetects: false,
    steps: [
      {
        text: "In your Webflow project, open Site settings, then Custom code, and paste the snippet into the Head code field. Publish the site to apply it.",
        code: DOCS_SNIPPET,
      },
      {
        text: "Custom code requires a paid Webflow site plan; the free tier does not apply it.",
      },
      VERIFY_STEP,
    ],
  },
  {
    slug: "shopify",
    name: "Shopify",
    cliDetects: false,
    steps: [
      {
        text: "In your Shopify admin, open Online Store, then Themes, then Edit code, and paste the snippet before </head> in theme.liquid.",
        code: DOCS_SNIPPET,
        caption: "layout/theme.liquid",
      },
      {
        text: "For purchase tracking, see the revenue guide: the conversion event with an order_id is what ties a payment to the visit.",
      },
      VERIFY_STEP,
    ],
  },
];

export function docFramework(slug: string): DocFramework | undefined {
  return DOC_FRAMEWORKS.find((framework) => framework.slug === slug);
}
