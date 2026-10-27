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

const page = docPage("revenue");
export const metadata = docsMetadata(page);

export default function RevenueDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Connecting Stripe">
        <p>
          Under your site&apos;s Settings, Integrations, connect Stripe with
          a restricted, read-only key: a couple of minutes, no code changes.
          From then on payments, refunds, disputes and fees flow into the
          Revenue tab, joined to the visits that produced them where a
          signal exists. Disconnecting stops the flow immediately.
        </p>
      </DocSection>

      <DocSection title="Connecting Dodo Payments">
        <p>
          The same two steps: an API key from the Dodo dashboard (Developer,
          API Keys — a dedicated key you can revoke on its own is the one to
          use), then a webhook endpoint at the address we show you, whose
          signing secret you paste back. Subscribe it to the{" "}
          <Code>payment.*</Code>, <Code>refund.*</Code> and{" "}
          <Code>dispute.*</Code> events; anything else it receives is
          acknowledged and ignored.
        </p>
        <p>
          Dodo is the merchant of record, so revenue is reported net of the
          tax it collects and remits. Refunds are recorded at the amount the
          customer got back, which includes that tax. Connect a live-mode key:
          test mode is a separate Dodo environment this connection does not
          read.
        </p>
        <p>
          For attribution, the <Code>payment_id</Code> Dodo appends to your
          checkout&apos;s return URL is the <Code>order_id</Code> to send with
          the conversion; to link by person instead, put the id you give{" "}
          <Code>identify()</Code> in the checkout&apos;s metadata as{" "}
          <Code>oa_external_id</Code>.
        </p>
      </DocSection>

      <DocSection title="Attribution is opt-in, and it asks something of you">
        <p>
          Revenue totals need nothing from your visitors. Tying a payment back
          to the visit that produced it is different on both counts: you turn{" "}
          <strong>Attributed revenue</strong> on when connecting Stripe — until
          you do, the script sends no <Code>order_id</Code> at all and the
          conversion is just a count — and the linking itself carries a consent
          obligation you meet as the controller of your site.
        </p>
        <p>
          The switch decides whether the link happens at all, not just what the
          script sends. An <Code>order_id</Code> that reaches us while it is off,
          from a cached copy of the script or a request you wrote yourself, is
          dropped before the event is stored; and the matcher skips your site
          entirely, so a payment is not linked through your own Stripe
          integration either (a <Code>client_reference_id</Code>, an id on the
          customer). Conversions are still counted and revenue totals are
          unaffected — what stops is the journey.
        </p>
        <p>
          Switching it off leaves the journeys you already have; it stops new
          ones. Switching it back on picks up roughly the last month of payments
          on the next pass — that is how far back the matcher re-reads — and
          older ones stay as they are.
        </p>
        <DocCode caption="wherever you record the visitor's choice">{`oa.consent("granted"); // or "denied", which stops collection entirely`}</DocCode>
        <p>
          We do not hold the hint back on a consent state we cannot see, so
          wiring this is yours to do. The best place to ask is your own checkout
          page: consent collected inside Stripe Checkout is consent for taking
          payment, and the analytics link is a different purpose with a
          different controller — you.
        </p>
      </DocSection>

      <DocSection title="Recipe 1: the order_id conversion (the strong one)">
        <p>Fire a conversion on your success page carrying the order:</p>
        <DocCode caption="success page">{`oa.conversion("purchase", { order_id: "cs_live_a1B2c3" });`}</DocCode>
        <DocList
          items={[
            <span key="ids">
              <Code>order_id</Code> is the Stripe Checkout Session (
              <Code>cs_…</Code>), PaymentIntent (<Code>pi_…</Code>) or
              charge id (<Code>ch_…</Code>), whichever your page has.
            </span>,
            "The join is exact: the transaction and its journey get confidence “exact”, the strongest the system issues.",
            "A conversion is a billable custom event, one unit; nothing about the recipe bills twice.",
          ]}
        />
      </DocSection>

      <DocSection title="Recipe 2: identify plus client_reference_id">
        <p>
          When your success page cannot know the order, pass the same stable
          user reference to both sides:
        </p>
        <DocCode caption="browser">{`oa.identify("user_8f21c4");`}</DocCode>
        <DocCode caption="server, creating the checkout">{`stripe.checkout.sessions.create({
  client_reference_id: "user_8f21c4",
  // ...
});`}</DocCode>
        <p>
          Both sides are hashed with the same site-scoped derivation and
          joined without either value ever being stored raw. This yields
          confidence &quot;linked&quot;: it identifies the person rather
          than the order, which is exactly what makes it the fallback. See{" "}
          <DocLink slug="identify">identify</DocLink> for the rules.
        </p>
      </DocSection>

      <DocSection title="What the reports show">
        <DocList
          items={[
            "Net revenue with its parts printed: gross, refunds, disputes, fees. A flat month of quiet trading and a flat month of heavy refunds look different here, on purpose.",
            "Gross and net share one chart; the gap between the lines is the cost of doing business.",
            "Payments the join could not attribute still count in every total; they simply have no journey. There is no IP matching and no time-proximity guessing, by policy.",
            "Currencies that could not be converted are listed beside the totals rather than silently dropped.",
          ]}
        />
      </DocSection>

      <DocSection title="Privacy">
        <DocNote>
          Card numbers never touch our servers, provider payloads are never
          persisted, and the customer reference is stored only as a
          non-joinable pseudonym. Revenue aggregates are readable over the
          API by the site owner; individual transactions never leave the
          dashboard.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
