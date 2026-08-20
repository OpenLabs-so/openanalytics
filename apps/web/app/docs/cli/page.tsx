import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("cli");
export const metadata = docsMetadata(page);

export default function CliDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Install">
        <DocCode caption="terminal">{`npm i -g getopen   # installs the oa command
# or one-off, no install:
npx getopen <command>`}</DocCode>
      </DocSection>

      <DocSection title="oa init: install the tracker">
        <p>
          Run it in your project folder. It detects the framework, asks for
          your tracking key, writes the snippet into the right file, prints
          which file it changed, and tells you what to do next. Idempotent:
          a project that already carries the snippet is left alone.
        </p>
        <DocCode caption="terminal">{`npx getopen init

# non-interactive (CI, scripts):
npx getopen init --key oa_pk_… --framework nextjs-app --yes`}</DocCode>
        <p>
          Detected frameworks: Next.js (App and Pages Router), TanStack
          Start, React, Vue, Nuxt, SvelteKit, Remix, Astro, Gatsby,
          WordPress and plain HTML.
          The <DocLink slug="install">installation guides</DocLink> show
          what it writes, per framework.
        </p>
      </DocSection>

      <DocSection title="Signing in and reading stats">
        <DocCode caption="terminal">{`oa login                 # OAuth device flow: a code, a browser approval
oa sites                 # the sites your account can read
oa stats --site my-site  # totals; add --from/--to as ISO instants
oa logout`}</DocCode>
        <DocList
          items={[
            "Sign-in is the OAuth device flow: the CLI never sees your password, and the grant is revocable any time from Account, Connected apps.",
            <span key="creds">
              Credentials live in{" "}
              <Code>~/.config/oa/credentials.json</Code>, restricted to your
              user (0600), and the CLI says out loud if the filesystem
              refused the restriction.
            </span>,
            <span key="scopes">
              The CLI is read-only by design: its scopes are{" "}
              <Code>site:read analytics:read realtime:read revenue:read</Code>
              , and nothing it can do mutates a site.
            </span>,
          ]}
        />
      </DocSection>

      <DocSection title="Pointing it elsewhere">
        <DocNote>
          <Code>OA_API_URL</Code> overrides the API base for self-hosted or
          staging deployments; <Code>--api</Code> does the same per
          invocation. JSON output for scripts: every read command takes{" "}
          <Code>--json</Code>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
