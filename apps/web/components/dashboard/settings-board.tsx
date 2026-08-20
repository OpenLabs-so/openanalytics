"use client";

import {
  Analytics01Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowTurnBackwardIcon,
  Cancel01Icon as XIcon,
  DashboardSquare01Icon,
  Key01Icon,
  PuzzleIcon,
  Settings02Icon,
  SourceCodeIcon,
  Tap01Icon,
  UserMultiple02Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { ApiKeysSection } from "@/components/dashboard/api-keys-section";
import {
  DangerZoneContentSkeleton,
  DeleteSiteSection,
} from "@/components/dashboard/delete-site-section";
import { ImportSection } from "@/components/dashboard/import-section";
import { IntegrationsSection } from "@/components/dashboard/integrations-section";
import {
  PublicDashboardSection,
  PublicDashboardSkeleton,
  usePublicDashboard,
} from "@/components/dashboard/public-dashboard-section";
import {
  SiteUsagePanel,
  TransferOfferSection,
  TransferOfferSkeleton,
  useTransferOffer,
} from "@seam/slots";
import { TeamSection } from "@/components/dashboard/team-section";
import { WidgetsSection } from "@/components/dashboard/widgets-section";
import { CopyButton } from "@/components/ui/copy-button";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { Button } from "@/components/ui/button";
import { SaveButton } from "@/components/ui/save-button";
import {
  SkeletonBar,
  SkeletonCircle,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import {
  SectionHeading,
  SettingsPanel,
} from "@/components/dashboard/settings-panel";
import {
  COLLECTOR_BASE_URL,
  keys as apiKeys,
  LIVE_API,
  sites,
  trackerSnippet,
  type SiteSummary,
} from "@/lib/api";
import {
  ADDITIONAL_REPORTING_CURRENCIES,
  currencyName,
  ECB_REFERENCE_CURRENCIES,
  isEcbConvertible,
} from "@/lib/currencies";
import { MOCK_KEYS, mockSiteBySlug } from "@/lib/mock";
import { useAction, useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Settings as a two-pane screen: the sections on the left, the selected one on
 * the right. Same split we used for the realtime page — a list that stays put
 * while its detail changes, so switching sections never costs you your place.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type TabId =
  | "general"
  | "installation"
  | "events"
  | "widgets"
  | "usage"
  | "api"
  | "transfer"
  | "integrations"
  | "team";

const TABS: { id: TabId; label: string; icon: typeof Settings02Icon }[] = [
  { id: "general", label: "General", icon: Settings02Icon },
  { id: "installation", label: "Installation", icon: SourceCodeIcon },
  // After installation, before usage: the order a site is actually set up in.
  { id: "events", label: "Events", icon: Tap01Icon },
  // Beside Events on purpose (§35): both are lists of saved definitions
  // describing what the site publishes, and both share `site:settings`.
  { id: "widgets", label: "Widgets", icon: DashboardSquare01Icon },
  // Per-site usage is real since M10.5 (§19) — its own section, because it
  // carries a meter and a month list rather than a setting.
  { id: "usage", label: "Usage", icon: Analytics01Icon },
  { id: "api", label: "API", icon: Key01Icon },
  {
    id: "transfer",
    label: "Import & Export",
    icon: ArrowDataTransferHorizontalIcon,
  },
  { id: "integrations", label: "Integrations", icon: PuzzleIcon },
  { id: "team", label: "Team", icon: UserMultiple02Icon },
];

const inputClass =
  "h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]";

/**
 * Install surface — docs/frontend/tracker_snippet.md verbatim. The site key is
 * the `tracking_write` public token: the browser ingest identifier, write-only
 * and public by design, which is why it is shown in full rather than behind
 * the copy-once dialog the API tab uses. The bundle is served from the
 * collector host (ADR-0020) and `async` is deliberate — the tracker records
 * the first pageview before its config round-trip completes.
 */
const snippetFor = (key: string) => trackerSnippet(key);

/** Attribute-marked events (ADR-0037/0038) — no key, so plain constants. */
const ATTRIBUTE_SNIPPET = '<button data-oa-event="signup">Sign up</button>';
const ATTRIBUTE_PROP_SNIPPET =
  '<a href="/signup" data-oa-event="signup" data-oa-prop-section="hero">\n  Get started\n</a>';

const nextSnippetFor = (
  key: string
) => `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script
          async
          src="${COLLECTOR_BASE_URL}/oa.js"
          data-key="${key}"
          data-collector="${COLLECTOR_BASE_URL}"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}`;

const htmlSnippetFor = (key: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script
      async
      src="${COLLECTOR_BASE_URL}/oa.js"
      data-key="${key}"
      data-collector="${COLLECTOR_BASE_URL}"
    ></script>
  </head>
  <body>
    <!-- your page -->
  </body>
</html>`;

export function SettingsBoard({ slug }: { slug: string }) {
  const [active, setActive] = React.useState<TabId>("general");

  // Deep links land on a named tab (`?tab=integrations` — the overview's
  // Revenue card uses it). Microtask hop so server render and hydration
  // agree on the default first.
  React.useEffect(() => {
    void Promise.resolve().then(() => {
      const requested = new URLSearchParams(window.location.search).get("tab");
      if (TABS.some((tab) => tab.id === requested)) {
        setActive(requested as TabId);
      }
    });
  }, []);

  // URLs carry the slug; the api speaks site_id. Resolve once here and hand
  // the summary to every section — none of them re-fetches identity.
  const site = useApi(
    () => sites.resolve(slug).then((found) => sites.get(found.site_id)),
    () => mockSiteBySlug(slug),
    slug
  );

  // Pixel-matched to the ready layout: real column widths, real nav row
  // metrics, a General-shaped panel — so the reveal never shifts a thing.
  // Handed to SkeletonReveal below, which cross-fades it into the board
  // with the house blur reveal.
  const skeleton = (
      <div
        aria-hidden="true"
        className="mx-auto flex w-full max-w-4xl flex-col gap-5 lg:flex-row lg:items-start lg:gap-8"
      >
        <div className="lg:w-52 lg:shrink-0">
          <div className="px-2.5 pb-4">
            <SkeletonBar className="h-7 w-24" />
          </div>
          <div className="-mx-2.5 flex gap-0.5 px-2.5 lg:mx-0 lg:flex-col lg:px-0">
            {/* One row per real tab, derived rather than counted: this was a
                hardcoded seven and silently went one short the day an eighth
                tab was added, which shifts the whole column on reveal. */}
            {TABS.map((tab) => (
              <div
                className="flex shrink-0 items-center gap-2.5 px-2.5 py-2"
                key={tab.id}
              >
                <SkeletonCircle className="size-4" />
                <SkeletonBar className="h-3.5 w-20" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6 lg:pt-11">
          <div className="px-1">
            <SkeletonBar className="h-4 w-24" />
            <SkeletonBar className="mt-2 h-3.5 w-72 max-w-full" />
          </div>
          {/* The General tab's own skeleton, so this reveal hands straight
              over to that one: the same panels at the same heights, and the
              tab's gate takes over from here. Owner and billing owner are
              assumed — the site is the thing still being resolved, and the
              settings screen you land on is nearly always your own. */}
          <GeneralPanelsSkeleton billingOwner owner />
        </div>
      </div>
  );

  if (site.phase === "error") {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm font-medium">{site.error.title}</p>
        <p className="text-sm text-muted-foreground">{site.error.body}</p>
        {site.error.retryable ? (
          <Button onClick={site.reload} size="sm" variant="secondary">
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <SkeletonReveal ready={site.phase === "ready"} skeleton={skeleton}>
      {site.phase !== "ready" ? null : (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
      {/* title + sections pin together as one block — lg:sticky needs the
          parent's items-start: a stretched flex child is as tall as the row
          and has nowhere to stick. top-22 = the column's natural offset
          (56px header + 32px main padding), so it pins without first
          drifting up to meet a lower threshold. */}
      <div className="lg:sticky lg:top-22 lg:w-52 lg:shrink-0">
        <h1 className="px-2.5 pb-4 text-xl font-medium tracking-tight">
          Settings
        </h1>
        {/* the sections — our own row language, same as the funnels and
            realtime lists: no framing panel, just rows that respond */}
        <nav
          aria-label="Settings sections"
          className="-mx-2.5 flex gap-0.5 overflow-x-auto px-2.5 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              aria-current={selected ? "page" : undefined}
              className={cn(
                "group relative flex shrink-0 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              key={tab.id}
              onClick={() => setActive(tab.id)}
              type="button"
            >
              {/* the highlight glides between rows rather than blinking */}
              {selected ? (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[10px] bg-accent"
                  layoutId="settings-highlight"
                  transition={SPRING}
                />
              ) : null}
              <tab.icon
                className={cn(
                  "relative size-4 shrink-0 transition-colors",
                  selected ? "text-foreground" : "text-muted-foreground/70"
                )}
              />
              <span className="relative whitespace-nowrap font-medium">
                {tab.label}
              </span>
            </button>
          );
        })}
        </nav>
      </div>

      {/* the selected section — lg:pt-11 matches the title block's height
          (28px line + 16px gap) so the panels start level with the menu */}
      <div className="min-w-0 flex-1 lg:pt-11">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-6"
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            initial={{ opacity: 0, y: 8 }}
            key={active}
            transition={SPRING}
          >
            {/* Import and Integrations bring their own headings — their
                screens are several groups, not one. */}
            {active === "general" ? (
              <>
                <SectionHeading
                  description={`What ${site.data.name} is called, which origins may send events, and who can see its numbers.`}
                  title="General"
                />
                <General site={site.data} />
              </>
            ) : null}
            {active === "installation" ? (
              <>
                <SectionHeading
                  description="Get the tracker onto your site. One line does it; the rest is convenience."
                  title="Installation"
                />
                <Installation site={site.data} />
              </>
            ) : null}
            {active === "events" ? (
              <>
                <SectionHeading
                  description="Name the things people do (a click, a submit, a signup) and they show up beside your pageviews."
                  title="Custom events"
                />
                <CustomEvents />
              </>
            ) : null}
            {active === "widgets" ? (
              <>
                <SectionHeading
                  description="Publish one of this site's numbers as a live iframe you can paste into any page. Viewers need no account."
                  title="Widgets"
                />
                <WidgetsSection site={site.data} />
              </>
            ) : null}
            {active === "usage" ? (
              <>
                <SectionHeading
                  description="What this site has sent this month."
                  title="Usage"
                />
                {SiteUsagePanel ? (
                  <SiteUsagePanel
                    isBillingOwner={site.data.is_billing_owner}
                    siteId={site.data.site_id}
                  />
                ) : (
                  <SettingsPanel title="Usage">
                    <p className="p-5 text-sm leading-6 text-muted-foreground">
                      This install has no quota, so there is no meter to show:
                      every event this site sends is stored.
                    </p>
                  </SettingsPanel>
                )}
              </>
            ) : null}
            {active === "api" ? (
              <>
                <SectionHeading
                  // M14/M16 (ADR-0042/0043) opened key-authenticated
                  // analytics reads — the line finally gets to promise them.
                  description="Bearer keys for this site. Tracking keys write events from the browser; read keys read your site and its analytics from your own code."
                  title="API"
                />
                <ApiKeysSection siteId={site.data.site_id} />
              </>
            ) : null}
            {active === "transfer" ? (
              <ImportSection site={site.data} />
            ) : null}
            {active === "integrations" ? (
              <IntegrationsSection site={site.data} />
            ) : null}
            {active === "team" ? (
              <>
                <SectionHeading
                  description={`Who can see ${site.data.name}, and what they are allowed to change.`}
                  title="Team"
                />
                <TeamSection site={site.data} />
              </>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
      )}
    </SkeletonReveal>
  );
}

/** A bare hostname with at least one dot — what the allowlist accepts. */
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * `PATCH /v1/sites/{site_id}` — `site:settings` (owner and admin). The slug is
 * not editable, and `domains` is replace-set: the list we send becomes the
 * exact allowlist, so the editor always submits the full list.
 */
/**
 * The General tab as bars, for the board's page-level skeleton — the moment
 * before the site summary lands, when not even panel titles' surroundings
 * (the project name, the intro lines) are knowable.
 *
 * Once the summary is in hand the tab never uses this: each panel draws its
 * own chrome statically and reveals only the content that waits on a read —
 * the house model, set by the API panel.
 */
/** Project settings' content as bars — shared by the page skeleton and the
 *  live panel's own reveal, so the two can never drift apart. */
function ProjectSettingsContentSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <SkeletonBar className="h-3.5 w-24" />
        <SkeletonBar className="mt-2 h-9 w-full rounded-xl" />
      </div>
      <div>
        <SkeletonBar className="h-3.5 w-28" />
        {/* One bar, because the Add button lives inside the field now —
            two would promise a layout the reveal does not land on. */}
        <SkeletonBar className="mt-2 h-9 w-full rounded-xl" />
        <SkeletonBar className="mt-2 h-3 w-80 max-w-full" />
      </div>
      <SkeletonBar className="h-8 w-32 rounded-full" />
    </div>
  );
}

function GeneralPanelsSkeleton({
  owner,
  billingOwner,
}: {
  owner: boolean;
  /** The billing-transfer panel exists only for whoever pays. */
  billingOwner: boolean;
}) {
  return (
    <>
      <SettingsPanel title="Project settings">
        <ProjectSettingsContentSkeleton />
      </SettingsPanel>

      <PublicDashboardSkeleton />

      {billingOwner ? <TransferOfferSkeleton /> : null}

      {owner ? (
        <SettingsPanel title="Danger zone" tone="destructive">
          <DangerZoneContentSkeleton />
        </SettingsPanel>
      ) : null}
    </>
  );
}

function General({ site }: { site: SiteSummary }) {
  const [name, setName] = React.useState(site.name);
  const [domains, setDomains] = React.useState<string[]>(site.domains);
  const [draft, setDraft] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  /**
   * Removing a domain is staged, not done.
   *
   * The chip stays on screen struck through until Save, because the two
   * removals a customer can make here have opposite consequences and both are
   * invisible at the moment of the click: dropping one of several stops that
   * origin's events being accepted, while dropping the **last** one empties
   * the allowlist — and an empty allowlist means *accept every origin*
   * (`isOriginAllowed` returns true on an empty list), not "accept none". A
   * chip that simply vanishes cannot say either of those things, and the
   * second is a security change nobody would expect from a delete.
   *
   * Undo is the same button in the same place, which is what makes staging
   * worth having over a confirm dialog.
   */
  const [pendingRemoval, setPendingRemoval] = React.useState<string[]>([]);
  const nextDomains = domains.filter((entry) => !pendingRemoval.includes(entry));

  /**
   * The reporting currency, and the currency the server last confirmed.
   *
   * Two values because the consequence copy depends on the *change*, not on
   * the value: restating a site's history is worth a sentence the one time it
   * is set in motion, and worth nothing on a save that only renamed the site.
   */
  const [currency, setCurrency] = React.useState(site.reporting_currency);
  const [appliedCurrency, setAppliedCurrency] = React.useState(
    site.reporting_currency
  );
  const [converting, setConverting] = React.useState(false);

  /**
   * The reporting timezone. `null` means "use the viewer's browser zone", which
   * is what an unset site did before this field existed and still does.
   *
   * It sits beside the currency because it is the same kind of decision — what
   * the numbers are expressed in — and because the two are read together when
   * someone is working out why a total looks off by a day.
   */
  const [timezone, setTimezone] = React.useState<string | null>(
    site.reporting_timezone ?? null
  );

  // The tab's two reads, started here so they run in parallel and share one
  // reveal moment. Their panels take the answers as props.
  const publicSettings = usePublicDashboard(site.site_id);
  const transferOffer = useTransferOffer(site.site_id);

  React.useEffect(() => () => clearTimeout(timeout.current), []);

  const save = useAction(async () => {
    setSaved(false);
    const currencyChanged = currency !== appliedCurrency;
    if (LIVE_API) {
      // Read the response back — the server normalizes and de-duplicates.
      const next = await sites.update(site.site_id, {
        name: name.trim(),
        domains: nextDomains,
        reporting_currency: currency,
        reporting_timezone: timezone,
      });
      setName(next.name);
      setDomains(next.domains);
      setPendingRemoval([]);
      setCurrency(next.reporting_currency);
      setAppliedCurrency(next.reporting_currency);
      setTimezone(next.reporting_timezone ?? null);
    } else {
      setAppliedCurrency(currency);
    }
    setConverting(currencyChanged);
    setSaved(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setSaved(false), 2000);
  });

  const addDomain = () => {
    const bare = draft.trim().toLowerCase().replace(/\.$/, "");
    if (bare.length === 0) return;
    if (!DOMAIN_PATTERN.test(bare)) {
      setFieldError(
        "Bare hostnames only: no scheme, port, path or wildcard, and localhost does not count."
      );
      return;
    }
    if (domains.length >= 10) {
      setFieldError("At most 10 domains per site.");
      return;
    }
    setFieldError(null);
    setDraft("");
    // Re-typing a domain that is staged for removal means "keep it" — the
    // alternative is a duplicate chip beside a struck-through one.
    setPendingRemoval((current) => current.filter((entry) => entry !== bare));
    setDomains((current) =>
      current.includes(bare) ? current : [...current, bare]
    );
  };

  const canEdit = site.role !== "viewer";

  // One gate for every panel's content, so the whole tab comes into focus in
  // the same frame. An error counts as settled: it is an answer, and its
  // panel renders it. Project settings and the danger zone fetch nothing
  // themselves, but the *tab* is loading, and a finished card beside pulsing
  // ones reads as a glitch — so their contents stand in and reveal too. Only
  // the chrome never waits.
  const revealed =
    publicSettings.phase !== "loading" && transferOffer.phase !== "loading";

  return (
    <>
      <SettingsPanel title="Project settings">
        <SkeletonReveal
          ready={revealed}
          skeleton={<ProjectSettingsContentSkeleton />}
        >
        {!revealed ? null : (
        <div className="flex flex-col gap-5 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Project name</span>
            <input
              className={inputClass}
              disabled={!canEdit}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Allowed domains</span>
            {domains.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {domains.map((entry) => {
                  const dropping = pendingRemoval.includes(entry);
                  return (
                    <li
                      className={cn(
                        "flex items-center gap-1 rounded-xl border py-1 pl-2.5 pr-1 font-mono text-xs transition-colors",
                        dropping
                          ? "border-dashed border-border bg-transparent text-muted-foreground line-through"
                          : "border-border bg-white"
                      )}
                      key={entry}
                    >
                      {entry}
                      {canEdit ? (
                        <button
                          aria-label={
                            dropping ? `Keep ${entry}` : `Remove ${entry}`
                          }
                          className="flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() =>
                            setPendingRemoval((current) =>
                              dropping
                                ? current.filter((name_) => name_ !== entry)
                                : [...current, entry]
                            )
                          }
                          type="button"
                        >
                          {dropping ? (
                            <ArrowTurnBackwardIcon className="size-3" />
                          ) : (
                            <XIcon className="size-3" />
                          )}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {canEdit ? (
              /* The button lives inside the field, in the share-link row's own
                 anatomy. The focus treatment moves to the shell with it: the
                 border belongs to the wrapper now, so `focus-within` is what
                 lights it — the inner input keeps no edge of its own, or the
                 field would draw two. */
              <div className="flex items-center gap-2 rounded-xl border border-input bg-white pb-1 pl-3 pr-2 pt-1 transition-[box-shadow,border-color] focus-within:border-ring focus-within:[outline:2px_solid_var(--ring)] focus-within:[outline-offset:-2px]">
                {/* Height comes from the padding and the button, exactly as
                    it does on the share-link row: 4 + 28 + 4 + 2 = the 38px
                    every other field in Settings now stands at. Fixing the
                    shell's height instead made the button hug the right edge,
                    because the 4px right padding that produced was half what
                    the row it copies uses. */}
                <input
                  aria-label="Add a domain"
                  className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setFieldError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addDomain();
                    }
                  }}
                  placeholder="example.com"
                  value={draft}
                />
                <Button
                  disabled={draft.trim().length === 0}
                  onClick={addDomain}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  Add domain
                </Button>
              </div>
            ) : null}
            {/* The contract is explicit: empty means "accept any origin",
                not "deny all" — say which state the site is in. Written
                against `nextDomains` so the sentence describes what Save
                would produce, not what is stored right now. */}
            <span className="text-xs leading-5 text-muted-foreground">
              {nextDomains.length === 0
                ? "No allowlist configured, so events are accepted from any origin. Add a domain to narrow it."
                : `Events are only accepted from ${nextDomains.length === 1 ? "this domain" : "these domains"}. Changes reach the tracker within a few minutes.`}
            </span>

            {/* Two removals, two different consequences, and neither is
                visible at the moment of the click.

                Emptying the allowlist is the one that surprises people: it
                reads like tightening and is the opposite. The site key sits
                in the page source by design, so an open allowlist means
                anyone holding it can write into these numbers. Losing one of
                several is the ordinary version — that origin's events stop
                being accepted, and because the tracker treats a non-429 4xx
                as final it does not retry them later. */}
            {pendingRemoval.length > 0 ? (
              <span
                className={cn(
                  "rounded-lg px-2.5 py-2 text-xs leading-5",
                  nextDomains.length === 0
                    ? "bg-amber-500/10 text-amber-700"
                    : "bg-black/4 text-muted-foreground"
                )}
              >
                {nextDomains.length === 0 ? (
                  <>
                    <strong>
                      {pendingRemoval.length === domains.length &&
                      domains.length > 1
                        ? "That removes every domain."
                        : "That removes the last domain."}
                    </strong>{" "}
                    Saving leaves no allowlist, and a site with no allowlist
                    accepts events from <strong>any</strong> origin, including
                    anyone who copies your site key out of your page source.
                    Add another domain first if you meant to narrow it.
                  </>
                ) : (
                  <>
                    Saving stops accepting events from{" "}
                    <span className="font-mono">
                      {pendingRemoval.join(", ")}
                    </span>{" "}
                    and any subdomain of{" "}
                    {pendingRemoval.length === 1 ? "it" : "them"}. Trackers pick
                    the change up within a few minutes, and putting it back
                    takes the same few minutes.
                  </>
                )}
              </span>
            ) : null}
            {fieldError ? (
              <span className="text-xs text-destructive-foreground">
                {fieldError}
              </span>
            ) : null}
          </div>

          {/* Reporting currency (M12, §26). A `site:settings` write like the
              two above it, so it shares their PATCH and their save button —
              but it is the only field here that restates stored history, and
              the copy under it changes with the choice rather than sitting
              still. */}
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-4 [&>*]:sm:flex-1 [&>*]:sm:min-w-0">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Reporting currency</span>
            <select
              className={cn(inputClass, "cursor-pointer appearance-none pr-8")}
              disabled={!canEdit}
              onChange={(event) => setCurrency(event.target.value)}
              value={currency}
            >
              {/* Two groups because they mean different things, not because
                  fifty options want dividing. */}
              <optgroup label="Converted daily">
                {ECB_REFERENCE_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code} - {currencyName(code)}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Settlement only (no conversion)">
                {ADDITIONAL_REPORTING_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code} - {currencyName(code)}
                  </option>
                ))}
              </optgroup>
            </select>
            <span className="text-xs leading-5 text-muted-foreground">
              {isEcbConvertible(currency)
                ? "What revenue is reported in. Payments taken in other currencies are converted at the European Central Bank's daily reference rate."
                : `${currency} is a settlement currency the ECB does not publish a rate for. It is accepted, but until a wider rate source lands, payments taken in any other currency stay uncounted in your totals rather than being converted: shown separately, never silently dropped.`}
            </span>
          </label>

          {/* Reporting timezone. Beside the currency deliberately: both answer
              "what are these numbers expressed in", and a total that looks a day
              out is read against this field. `null` keeps the old behaviour —
              whatever zone the viewer's browser is in. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Reporting timezone</span>
            <TimezoneSelect
              ariaLabel="Reporting timezone"
              disabled={!canEdit}
              nullLabel="Each viewer's own timezone"
              onPick={setTimezone}
              value={timezone}
              variant="field"
            />
            <span className="text-xs leading-5 text-muted-foreground">
              Which day a number belongs to. Left unset, every viewer sees the
              site in their own browser&apos;s zone, so two people can read the
              same range differently.
            </span>
          </label>
          </div>

          <div className="flex items-center gap-3">
            <SaveButton
              disabled={!canEdit}
              state={save.busy ? "saving" : saved ? "saved" : "idle"}
              onClick={() => save.run()}
              size="sm"
            >
              Save changes
            </SaveButton>
            {save.error ? (
              <span className="text-xs text-destructive-foreground">
                {save.error.body}
              </span>
            ) : null}
          </div>

          {/* Changing the currency re-materializes every stored fact and
              re-rolls every bucket, newest first, a month at a time. It is a
              recompute rather than a re-ingest and it is queued in the same
              transaction as the write — but it is not instant, and there is no
              completion signal to poll for. So the honest thing is to say it
              once and let the numbers settle, rather than to show a progress
              bar for something nobody is counting. It outlives the two-second
              "Saved" flash on purpose: the work does too. */}
          {converting ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Converting your history to {appliedCurrency}: recent periods
              update first, older ones over the next few minutes. Charts read
              during the change can show {appliedCurrency} labels over figures
              that have not been restated yet.
            </p>
          ) : null}
        </div>
        )}
        </SkeletonReveal>
      </SettingsPanel>

      <PublicDashboardSection
        loaded={publicSettings}
        revealed={revealed}
        site={site}
      />

      <TransferOfferSection
        loaded={transferOffer}
        revealed={revealed}
        site={site}
      />

      {/* `site:delete` is owner-only (§16) — the section exists only for
          owners rather than sitting disabled under everyone else. */}
      {site.role === "owner" ? (
        <DeleteSiteSection revealed={revealed} site={site} />
      ) : null}
    </>
  );
}


/* ------------------------------------------------------------------ */

/**
 * A block of code inside a panel inset: white card, optional file name in a
 * strip above it — the same head-and-body split the panel itself uses, one
 * level down. Long lines scroll rather than wrap, so indentation survives.
 */
function CodeBlock({
  caption,
  children,
}: {
  caption?: string;
  children: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      {caption ? (
        <div className="border-b border-border px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
          {caption}
        </div>
      ) : null}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-6">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** Sits above a code block to say what the block is for. */
function InstallNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-6 text-muted-foreground">{children}</p>
  );
}

// Manual install, deliberately: the official plugin's PHP half is not
// shipped yet (docs/wordpress/README.md is the contract it will be written
// against), so this card must not promise a directory listing that is not
// there. When the plugin lands, these steps become "install, paste key".
const WORDPRESS_STEPS = [
  "In wp-admin, open Appearance → Theme File Editor and select your theme's header.php (use a child theme if you have one).",
  "Copy the tracking snippet from the top of this page and paste it right before the closing </head> tag.",
  "Save. The next page load is counted.",
];

/**
 * Custom events — the teaching surface, on its own tab.
 *
 * It sat under Installation for a day and did not belong there: installation
 * is a one-time act with a copy button at the end, and this is the thing a
 * customer comes back to every time they want to measure something new. It
 * also needs neither the site key nor any read, so unlike every panel on that
 * tab it is real from the first frame.
 *
 * The dashboard only ever *reads* events. Everything that creates one lives in
 * the customer's markup or code, which is why this tab teaches rather than
 * configures — the rule builder that used to configure them was retired after
 * field-testing (ADR-0034 superseded by ADR-0037/0038).
 */
function CustomEvents() {
  /**
   * This panel has nothing to fetch, so its skeleton is a **deliberate
   * exception** to the house rule that a stand-in only ever covers a real
   * wait.
   *
   * Every other settings tab loads something, so switching between them has a
   * rhythm: frame, stand-in, content coming into focus. A tab that snapped
   * straight to finished content in the middle of that set did not read as
   * fast — it read as a different screen. The cost is a quarter of a second
   * on a tab that is pure documentation and nothing time-critical.
   *
   * 260ms because it has to be long enough to register as a state: a
   * stand-in that flashes for one frame is worse than none at all. If this
   * tab ever gains a real read — the event names already arriving is the
   * obvious one — delete the timer and gate on that instead.
   */
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const settle = setTimeout(() => setReady(true), 260);
    return () => clearTimeout(settle);
  }, []);

  const noteLines = (widths: string[]) => (
    <div>
      {widths.map((width, index) => (
        <span className="flex h-6 items-center" key={index}>
          <SkeletonBar className={`h-3.5 ${width}`} />
        </span>
      ))}
    </div>
  );
  const codeLines = (widths: string[]) =>
    widths.map((width, index) => (
      <span className="flex h-6 items-center" key={index}>
        <SkeletonBar className={`h-3 max-w-full ${width}`} />
      </span>
    ));
  /** Pixel-matched to the body below: one code line, a three-line note, a
   *  three-line block, then two more notes at their real leading. */
  const bodySkeleton = (
    <div className="flex flex-col gap-3 p-5">
      <div className="overflow-hidden rounded-xl border border-border bg-white px-4 py-3">
        {codeLines(["w-72"])}
      </div>
      {noteLines(["w-full", "w-full", "w-3/4"])}
      <div className="overflow-hidden rounded-xl border border-border bg-white px-4 py-3">
        {codeLines(["w-80", "w-24", "w-8"])}
      </div>
      {noteLines(["w-full", "w-full", "w-full", "w-1/2"])}
      {noteLines(["w-full", "w-full", "w-2/5"])}
    </div>
  );

  return (
    <>
    {/* The attribute is the only tracking feature a customer cannot discover
        by reading the snippet, and it is the one that answers "how do I track
        a button without a developer". So it leads. */}
    <SettingsPanel
      action={
        ready ? (
          <CopyButton label="Copy attribute example" text={ATTRIBUTE_SNIPPET} />
        ) : (
          <SkeletonBar className="size-8 animate-pulse rounded-xl" />
        )
      }
      title="Track clicks without code"
    >
      <SkeletonReveal ready={ready} skeleton={bodySkeleton}>
      {!ready ? null : (
      <div className="flex flex-col gap-3 p-5">
        <CodeBlock>{ATTRIBUTE_SNIPPET}</CodeBlock>
        <InstallNote>
          Put <code className="font-mono">data-oa-event</code> on any element
          and a click on it becomes a named custom event: no JavaScript, no
          build step, nothing to configure here. On a{" "}
          <code className="font-mono">&lt;form&gt;</code> it fires on submit
          instead. Names follow the same grammar as{" "}
          <code className="font-mono">oa.track()</code>; an invalid one sends
          nothing rather than something wrong.
        </InstallNote>
        <CodeBlock>{ATTRIBUTE_PROP_SNIPPET}</CodeBlock>
        <InstallNote>
          Add <code className="font-mono">data-oa-prop-*</code> on the same
          element to say <em>which</em> one: two CTAs, one event name, one
          property telling them apart. Write the key in kebab-case: HTML
          lowercases attribute names, so{" "}
          <code className="font-mono">data-oa-prop-buttonLabel</code> quietly
          becomes <code className="font-mono">buttonlabel</code>.
        </InstallNote>
        <InstallNote>
          Each click bills as one custom event. Don&apos;t also call{" "}
          <code className="font-mono">oa.track()</code> with the same name on
          the same element; that is one click described twice, and it bills
          twice.
        </InstallNote>
      </div>
      )}
      </SkeletonReveal>
    </SettingsPanel>
    </>
  );
}

function Installation({ site }: { site: SiteSummary }) {
  // The site key is the tracking_write key's public token — on the key list
  // for any existing site, not just the create response.
  const keyList = useApi(
    () => apiKeys.list(site.site_id).then((page) => page.items),
    () => MOCK_KEYS,
    site.site_id
  );

  const siteKey =
    keyList.data?.find(
      (entry) => entry.type === "tracking_write" && entry.public_token
    )?.public_token ?? null;

  // Per-panel content skeletons, pixel-matched to the bodies they stand in
  // for: code lines at the real leading-6 rhythm, notes at their 24px line
  // slots. The panels' chrome — frames, titles — never waits: it is real from
  // the first frame, and only these bodies swap. The copy buttons in the
  // strips wait too (they need the key), so their slots hold a self-pulsing
  // 32px square that swaps in place, like the API panel's key count.
  const codeLines = (widths: string[]) =>
    widths.map((width, index) => (
      <span className="flex h-6 items-center" key={index}>
        <SkeletonBar className={`h-3 max-w-full ${width}`} />
      </span>
    ));
  const noteLines = (widths: string[]) => (
    <div>
      {widths.map((width, index) => (
        <span className="flex h-6 items-center" key={index}>
          <SkeletonBar className={`h-3.5 ${width}`} />
        </span>
      ))}
    </div>
  );
  const copyAction = <SkeletonBar className="size-8 animate-pulse rounded-xl" />;

  const cliSkeleton = (
    <div className="flex flex-col gap-3 p-5">
      {noteLines(["w-2/5"])}
      <div className="overflow-hidden rounded-xl border border-border bg-white px-4 py-3">
        {codeLines(["w-40"])}
      </div>
      {noteLines(["w-full", "w-full", "w-1/3"])}
      <div className="rounded-xl border border-border bg-white px-4 py-3">
        <span className="flex h-4 items-center">
          <SkeletonBar className="h-3 w-80 max-w-full" />
        </span>
      </div>
    </div>
  );

  const snippetSkeleton = (
    <div className="flex flex-col gap-3 p-5">
      <div className="overflow-hidden rounded-xl border border-border bg-white px-4 py-3">
        {codeLines(["w-16", "w-24", "w-72", "w-56", "w-64", "w-20"])}
      </div>
      {noteLines(["w-full", "w-full", "w-2/3"])}
      {noteLines(["w-full", "w-1/2"])}
    </div>
  );
  const siteKeySkeleton = (
    <div className="flex flex-col gap-3 p-5">
      <div className="rounded-xl border border-border bg-white px-4 py-3">
        <span className="flex h-4 items-center">
          <SkeletonBar className="h-3 w-80 max-w-full" />
        </span>
      </div>
      {noteLines(["w-full", "w-full", "w-1/3"])}
    </div>
  );
  const codePanelSkeleton = (caption: string) => (
    <div className="flex flex-col gap-3 p-5">
      <div className="overflow-hidden rounded-xl border border-border bg-white">
        <div className="flex h-[29px] items-center border-b border-border px-4">
          <SkeletonBar className={`h-3 ${caption}`} />
        </div>
        <div className="px-4 py-3">
          {codeLines(
            Array.from(
              { length: 15 },
              (_, index) =>
                ["w-64", "w-40", "w-52", "w-32", "w-44", "w-60", "w-36"][
                  index % 7
                ]
            )
          )}
        </div>
      </div>
      {noteLines(["w-full", "w-3/5"])}
    </div>
  );

  const ready = keyList.phase !== "loading";

  if (ready && !siteKey) {
    return (
      <SettingsPanel title="Tracking snippet">
        <p className="p-5 text-sm text-muted-foreground">
          {keyList.phase === "error"
            ? keyList.error.body
            : "This site has no tracking key. Create one on the API tab and the snippet appears here."}
        </p>
      </SettingsPanel>
    );
  }

  // Null-tolerant: while loading these feed nothing (the reveals show the
  // skeletons), and the no-key case returned above.
  const snippet = snippetFor(siteKey ?? "");
  const nextSnippet = nextSnippetFor(siteKey ?? "");
  const htmlSnippet = htmlSnippetFor(siteKey ?? "");
  const domainLabel = site.domains[0] ?? site.name;

  return (
    <>
      {/* The CLI leads: it is the install that does the work itself. Two
          steps, the add-site dialog's own script: run the command, paste the
          key when it asks — so the key is right here, not two panels away. */}
      <SettingsPanel
        action={
          ready ? (
            <CopyButton label="Copy command" text="npx getopen init" />
          ) : (
            copyAction
          )
        }
        title="Install with the CLI"
      >
        <SkeletonReveal ready={ready} skeleton={cliSkeleton}>
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              <InstallNote>1. Run this in your project folder.</InstallNote>
              <CodeBlock>npx getopen init</CodeBlock>
              <InstallNote>
                2. When it asks for the tracking key, paste this one. It
                detects your framework, writes the snippet into the right
                file, and then you deploy.
              </InstallNote>
              <div className="flex items-center gap-1 rounded-xl border border-border bg-white py-1 pl-4 pr-1">
                <p className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-xs">
                  {siteKey}
                </p>
                <CopyButton label="Copy tracking key" text={siteKey ?? ""} />
              </div>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>

      <SettingsPanel
        action={
          ready ? <CopyButton label="Copy snippet" text={snippet} /> : copyAction
        }
        title="Tracking snippet"
      >
        <SkeletonReveal ready={ready} skeleton={snippetSkeleton}>
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              <CodeBlock>{snippet}</CodeBlock>
              <InstallNote>
                Paste this into the{" "}
                <code className="font-mono">&lt;head&gt;</code> of every page on{" "}
                {domainLabel}. It loads async and records the first pageview
                before its config round-trip finishes. The realtime view is the
                fastest confirmation: a visit shows up within seconds.
              </InstallNote>
              {/* The allowlist changes what the collector accepts; say which
                  state this site is in rather than letting a customer guess. */}
              <InstallNote>
                {site.domains.length === 0
                  ? "No domain allowlist is configured, so events are accepted from any origin. Narrow it under General."
                  : `Events are only accepted from ${site.domains.join(", ")} (configured under General).`}
              </InstallNote>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>

      <SettingsPanel
        action={
          ready ? (
            <CopyButton label="Copy site key" text={siteKey ?? ""} />
          ) : (
            copyAction
          )
        }
        title="Tracking key"
      >
        <SkeletonReveal ready={ready} skeleton={siteKeySkeleton}>
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              <p className="overflow-x-auto whitespace-nowrap rounded-xl border border-border bg-white px-4 py-3 font-mono text-xs">
                {siteKey}
              </p>
              <InstallNote>
                Safe to ship in the browser. This key can only write events for{" "}
                {domainLabel}; it can never read your analytics. Other key
                types live on the API tab.
              </InstallNote>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>

      <SettingsPanel
        action={
          ready ? (
            <CopyButton label="Copy Next.js snippet" text={nextSnippet} />
          ) : (
            copyAction
          )
        }
        title="Next.js"
      >
        <SkeletonReveal ready={ready} skeleton={codePanelSkeleton("w-24")}>
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              <CodeBlock caption="app/layout.tsx">{nextSnippet}</CodeBlock>
              <InstallNote>
                In the root layout the tracker loads once and survives
                client-side navigation, so route changes are counted without a
                reload.
              </InstallNote>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>

      <SettingsPanel
        action={
          ready ? (
            <CopyButton label="Copy HTML snippet" text={htmlSnippet} />
          ) : (
            copyAction
          )
        }
        title="HTML"
      >
        <SkeletonReveal ready={ready} skeleton={codePanelSkeleton("w-20")}>
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              <CodeBlock caption="index.html">{htmlSnippet}</CodeBlock>
              <InstallNote>
                Anywhere in the head works. Put it last if you want your own
                critical tags to parse first.
              </InstallNote>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>

      {/* Nothing here waits on the key — but the *tab* is loading, and a
          finished card under four pulsing ones reads as a glitch. So its
          content stands in too and the whole tab comes into focus at once. */}
      <SettingsPanel title="WordPress">
        <SkeletonReveal
          ready={ready}
          skeleton={
            <div className="flex flex-col gap-3 p-5">
              <div className="flex flex-col gap-2.5">
                {["w-96", "w-80", "w-64"].map((width, index) => (
                  <div className="flex gap-3" key={index}>
                    <SkeletonBar className="mt-0.5 size-5 shrink-0 rounded-full" />
                    <span className="flex h-6 flex-1 items-center">
                      <SkeletonBar className={`h-3.5 max-w-full ${width}`} />
                    </span>
                  </div>
                ))}
              </div>
              {noteLines(["w-4/5"])}
            </div>
          }
        >
          {!ready ? null : (
            <div className="flex flex-col gap-3 p-5">
              {/* Numbered because this genuinely is a sequence — you cannot
                  paste the key before the plugin exists. */}
              <ol className="flex flex-col gap-2.5">
                {WORDPRESS_STEPS.map((step, index) => (
                  <li className="flex gap-3 text-sm leading-6" key={step}>
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-medium tabular-nums text-muted-foreground ring-1 ring-border"
                    >
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <InstallNote>
                A theme update can overwrite header.php, taking the snippet
                with it — a child theme keeps it in place. An official
                WordPress plugin is on the way; until it ships, the snippet
                works here exactly as on any other site.
              </InstallNote>
            </div>
          )}
        </SkeletonReveal>
      </SettingsPanel>
    </>
  );
}

/* ------------------------------------------------------------------ */

