# Sentinel Assess channel guide for integrators

For owners, admins, and estimators at systems integrators and security contractors who deliver Sentinel Assess assessments and quote the remediation work. Phase 4 scope. Contract details: `docs/api-phase4.md`; schemas: `packages/shared/src/channel.ts`.

> **About prices.** The starter price book is a set of illustrative placeholders. Every material cost, labor hour, and margin in it is a made-up example in a plausible US range so you can see how quoting works. They are not market prices, vendor quotes, or recommendations. Replace them with your own numbers before you send a quote to anyone.

## 1. What to configure first

Do these in order on day one; it takes about an hour.

1. **Branding** (admin): display name, logo, primary and accent colors, report footer, contact email, phone, website.
2. **Quote settings** (admin): default labor rate, minimum margin, default terms, and how many days a quote stays valid.
3. **Price book** (admin): import the starter template, then go through every line and put in your own costs, labor hours, and margins. Turn off items you do not sell.
4. **Team** (admin): invite your assessors, estimators, and viewers.
5. **Clients and sites**: add your first client and its sites.
6. **Client logins** (admin): only once the first assessment is complete and you are ready for the client to see it.

## 2. Your workspace

Your workspace is your company's private space in Sentinel Assess. Everything lives inside it: your branding, team, clients, sites, assessments, photos, price book, and quotes. Nothing in your workspace is visible to any other integrator, and the database enforces that separation on every query, not just the screens.

Roles, from most to least access:

| Role | Who it is for | What they can do |
|---|---|---|
| Owner | The business owner or principal | Everything, including approving quotes that fall below your minimum margin, and creating other owners or admins |
| Admin | Office or operations lead | Branding, team, price book, quote settings, sending quotes, client logins |
| Assessor | Field assessors and estimators | Run assessments, create and edit draft quotes |
| Viewer | Sales or management who only need to read | Read assessments, reports, quotes, and the portfolio |
| Client viewer | Your client's contact | Only the client portal for their own company: completed assessments, reports, and quotes you have sent |

There must always be at least one active owner; the last owner cannot be demoted or disabled.

## 3. Branding

Your branding appears in the app header, report previews, Google Docs exports, quote previews, and the client portal.

- **Logo**: PNG or JPEG, up to 2 MB. We re-encode it as a PNG up to 512 by 512 pixels and strip hidden metadata such as camera or location details. SVG is not accepted.
- **Colors**: the primary color is used behind white text, so it must be dark enough to read (a contrast ratio of at least 4.5 to 1). If it is too light, the app tells you and keeps your old color.
- **"Powered by Sentinel Assess"**: shown on reports and the portal by default. Only the partner plan can turn it off. Your plan is set by the Sentinel Assess team; ask your account contact if you want to change it.

## 4. Team members and client logins

When you add a person, the app gives you a one-time setup link. The app does not send email yet, so copy the link and send it yourself through your normal channel (email, text, or your PSA). The link works once and expires after 72 hours; if it lapses, create a new one.

If the email address already has a Sentinel Assess login (for example, a subcontractor who works for two integrators), they are added to your workspace and keep their existing password.

**Client logins** are client viewer accounts tied to exactly one of your clients. A client viewer:

- sees only that client's completed assessments, the approved report, confirmed findings, and quotes you have sent;
- never sees draft work, AI suggestions that were not accepted, other clients, your price book, your costs, or your margins;
- can accept or decline a sent quote, which records their name, the time, and the tier they chose.

Disable a client login at any time from the team page; it stops working immediately.

## 5. Price book

The price book is your catalog of products, labor, and services. Each item has:

| Field | What it means |
|---|---|
| SKU | Your code; must be unique in your workspace |
| Name and description | What the client sees on the quote line |
| Category | Hardware, software, labor, service, or subscription |
| Unit | Each, ft, hour, lot, month, or year |
| Material cost | What it costs you per unit (parts or subcontractor) |
| Labor hours | Hours per unit; priced at the quote's labor rate |
| Default margin | Starting margin for new quote lines |
| Controls | The security controls this item fixes; this is how the app knows to suggest it for a finding |
| Asset types | Optional; items that match the finding's asset type rank higher |
| Tier | Good, better, best, or any (any means it appears in every tier) |

**Importing the starter template.** "Import starter price book" copies about 70 common remediations into your workspace: fencing, gates, bollards, lighting, cameras, recorders, access control, door hardware, intrusion, guard equipment, policy and training services, and cyber items such as MFA, EDR, backup, segmentation, logging, tabletop exercises, crypto inventory, and post-quantum migration planning. Items whose SKU you already have are skipped, so importing twice is safe and never overwrites your edits.

**How the tiers in the template work.** Many findings have a good, better, and best fix. For a cut in a chain-link fence:

- Good: chain-link fabric repair (per ft);
- Better: fabric repair plus bottom tension wire (per ft);
- Best: section replacement with anti-climb mesh (per ft).

Items marked "any" (for example a perimeter sign or an MFA rollout) have no cheaper or richer alternative and appear in every tier.

**Deleting items.** If an item has ever been used on a quote, deleting it only turns it off, so old quotes still make sense. Turned-off items are never suggested.

A few controls deliberately have no starter item (for example loading dock control, rack locks, alarm testing, officer training, personnel screening, site risk assessment, maintenance and image, and activity support), because the fix varies too much by site. Findings on those controls arrive in the quote as "Needs pricing" lines. Add your own items for them if you quote them often.

## 6. Quotes

### Creating a quote

Open a completed assessment and choose "Create quote". The app builds a draft from the assessment's **confirmed** findings only (AI suggestions that nobody accepted are never quoted):

1. For each finding, it looks for active price book items that fix one of the finding's controls, preferring items that match the finding's asset type.
2. It places each item in its tier, so one finding can produce a good, a better, and a best line.
3. If nothing matches, it adds one **Needs pricing** line for that finding so it does not silently drop off the quote.

Quote numbers look like `Q-2026-0001` and count up per workspace.

### Editing a draft

- Change quantities (the app cannot measure feet of fence or count doors for you; check every quantity), descriptions, costs, labor hours, and margins.
- Move lines between tiers, or set a line to "All tiers".
- Mark a line **optional**: it is priced separately and not included in the tier total, which is useful for add-ons the client can pick.
- Choose which tiers the quote shows. One tier means a single-option quote.

**How prices are worked out.** Each line's unit price is cost divided by (1 minus margin), where cost is material plus labor hours times the labor rate. For example, with $100 of material, 1 labor hour at $95 an hour, and a 35 percent margin: cost is $195, and the unit price is $195 divided by 0.65, which is $300. The app, the preview, and the CSV all use the same calculation, so totals always agree.

Internal users see cost, price, margin, and margin percent per tier. Clients only see prices.

### Submitting, approval, and sending

| Step | Who | What happens |
|---|---|---|
| Submit | Assessor or above | Draft becomes **Approved**, or **Pending approval** if any tier's margin is under your minimum. A quote with any Needs pricing line cannot be submitted until every such line is priced or removed. |
| Approve | Owner only | Pending approval becomes Approved |
| Send | Admin or owner | Approved becomes **Sent** and appears in the client portal |
| Accept or decline | Client viewer, or an admin recording the client's answer | Sent becomes **Accepted** (with the chosen tier) or **Declined** (with an optional reason) |
| Revise | Anyone who can edit quotes | Makes a new draft copy numbered with a suffix, such as `Q-2026-0001-R2`; the original stays as it was |

Once a quote leaves draft it is locked. To change it, revise it. Every step is written to the audit log with who did it and when.

Phase 4 quotes are proposals only: no e-signatures, sales tax, or payments. Add your tax and legal terms in the terms field, and export the CSV into your own accounting or PSA tool.

### Previews and exports

- **Preview**: a branded proposal page with your logo, colors, footer, and contact details.
- **CSV**: lines and tier totals for spreadsheets and accounting tools. Cells that start with characters a spreadsheet could treat as a formula are made safe automatically.

## 7. The client portal

Client viewers sign in and land in the portal, branded as you. They see, for their company only:

- completed assessments with the site name, completion date, overall residual risk level, and open finding counts;
- the approved report (only narrative a person on your team approved);
- confirmed findings and which framework requirements they relate to;
- quotes you have sent, accepted, or declined, with tier totals and a branded preview, and buttons to accept a tier or decline.

They never see drafts, quotes waiting for approval, internal costs, margins, or other clients. Your own team can preview what a client sees by opening the portal view for that client.

## 8. Portfolio

The portfolio view shows, for each client and site:

- the risk trend across completed assessments, oldest first, so it reads left to right;
- open findings by severity;
- quotes sent and accepted, accepted value, and open value.

Use it for quarterly reviews and to spot sites that are getting worse or have open quotes. If the scoring method or control library changed between assessments, the view shows a caveat; compare those scores with care.

## 9. Good habits

- Check every quantity before submitting. The app suggests items, not amounts.
- Keep the price book current: review costs at least quarterly.
- Set a minimum margin so low-margin quotes reach the owner automatically.
- Do not create client logins until the client should see completed work.
- Revise instead of starting over, so the client's history stays clear.

## 10. UX copy recommendations (for the frontend)

Proposed wording so the quote editor and portal speak the same language. Plain English, sentence case, no em dashes.

**Price book and illustrative prices**

- Banner on the price book after a template import, until every imported item has been edited or the admin dismisses it: "These starter prices are illustrative placeholders, not market prices. Replace them with your own costs, labor hours, and margins before you send a quote."
- Per-item badge on unedited template items: "Placeholder price".
- Banner in the quote editor when any line still uses an unedited template price: "This quote uses placeholder prices from the starter price book. Check them before you submit." (Assumption: the frontend can tell template items apart, for example by an unchanged SKU and values. Flagged as an open question.)
- Import button: "Import starter price book". Result: "Added 68 items. Skipped 0 that you already have."
- Empty price book: "Your price book is empty. Import the starter price book to get going, or add your first item."

**Quote editor**

- Create button on an assessment: "Create quote". Disabled state: "Finish and complete the assessment to create a quote."
- No confirmed findings: "There are no confirmed findings to quote yet. Confirm findings in the assessment first, or add lines by hand."
- Needs pricing line badge: "Needs pricing". Tooltip: "No price book item fixes this finding yet. Add an item or enter a price."
- Submit blocked: "Price or remove the 3 lines marked Needs pricing before submitting."
- Below minimum margin, before submit: "The Good tier margin is 14%, under your 20% minimum. Submitting will send this quote to an owner for approval."
- Tier column labels: "Good", "Better", "Best", "All tiers". Optional toggle: "Optional add-on".
- Totals row labels for internal users: "Cost", "Price", "Margin", "Margin %", "Optional add-ons".
- Locked quote: "This quote is locked because it has been submitted. Revise it to make changes."
- Quantity hint on new lines: "Check quantity".
- Status labels: "Draft", "Pending approval", "Approved", "Sent", "Accepted", "Declined", "Expired".

**Client portal**

- Empty portal: "No completed assessments yet. Your security provider will share results here when they are ready."
- No quotes: "No proposals yet."
- Tier cards: "Good", "Better", "Best" with price, then "Optional add-ons (not included)".
- Accept dialog: "Accept the Better option for $12,480.00? Type your full name to confirm." Button: "Accept proposal". Note under it: "This records your acceptance and notifies your provider. It is not a payment."
- Decline dialog: "Decline this proposal? You can tell us why (optional)." Button: "Decline proposal".
- After responding: "Accepted by Carmen Diaz on 6 Nov 2026, Better option."
- Expired: "This proposal expired on 6 Dec 2026. Contact your provider for an updated proposal."
- Prices are exclusive of tax: "Prices exclude tax unless stated in the terms."
