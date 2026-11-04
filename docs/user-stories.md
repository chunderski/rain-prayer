# Sentinel Assess: User Stories

Owner: channel-product-manager. Status: draft for review by the Head of Engineering and CW (product owner).

This document covers all four phases. Each story has an ID (US-phase.number), a MoSCoW priority (Must, Should, Could, Won't for now), and Given/When/Then acceptance criteria. Stories are written for the buyers and users of the product: systems integrators, their field assessors, their sales staff, and the end clients who receive reports.

## About the reference products

Our mission brief names two North Star references. What the brief says about them is used here as context; nothing below has been independently verified.

- EasySet: described in the brief as offering fast guided field walkthroughs with photos that become a branded report. Assumption: its walkthroughs are checklist-driven and it does not offer AI photo analysis or quoting. Not verified.
- Circadian Risk: described in the brief as offering quantified inherent, control, and residual risk scoring, portfolio comparison, and offline sync. Assumption: it focuses on physical security and does not combine cyber frameworks (NIST CSF 2.0, PQC readiness) in one assessment. Not verified.

Where a story says "parity" or "differentiator", that judgement rests on these assumptions.

## Personas

| Persona | Who they are | What they need most |
|---|---|---|
| Integrator owner/admin (Olivia) | Runs or manages a systems integrator or security contractor; sets up the workspace, users, branding, and clients. | Control over who sees what; reports and quotes that carry her brand; a view across all clients. |
| Field assessor (Frank) | On site with a phone, often gloved, in sun or dark, with poor or no signal and limited time. | Fast capture with one hand; nothing lost when offline; AI that saves typing but never overrides him. |
| Client stakeholder (Carmen) | Facilities, security, or IT lead at the end client; receives the report. Read-only. | A clear, credible report she can forward to her executives; scores she can understand. |
| Integrator sales/estimator (Sam) | Turns findings into priced remediation proposals. | Findings that map cleanly to products and labor; margin control; a quote the client can say yes to. |

---

## Phase 1: Foundation

**US-1.01 Sign in with Google** (Must)
As any user, I want to sign in with my Google account, so that I do not manage another password and exports to Google work later.
- Given I have an invited account, When I choose "Sign in with Google" and consent, Then I land in my workspace home.
- Given my Google email has no invitation, When I sign in, Then I see "No workspace found; ask your administrator for an invite" and no data is shown.
- Given I am signed in, When I sign out, Then local session tokens are cleared and cached data is locked until I sign in again.

**US-1.02 Session on a shared or lost device** (Should)
As an integrator admin, I want to revoke a user's sessions, so that a lost phone does not expose client data.
- Given a user has active sessions, When I choose "Revoke sessions", Then every device for that user requires sign-in on next request.
- Given a revoked device is offline, When it reconnects, Then unsynced captures are held and the user must sign in before they upload.

**US-1.03 Create a workspace (tenant)** (Must)
As an integrator owner, I want to create a workspace for my company, so that my clients, users, and data are isolated from every other company.
- Given I am a new owner, When I create a workspace with a company name, Then I become its owner and only members can see its data.
- Given two workspaces exist, When a user of one queries any record, Then records from the other are never returned (enforced at the database, not only the UI).

**US-1.04 Invite users and assign roles** (Must)
As an integrator admin, I want to invite users with a role (owner, admin, assessor, estimator, client viewer), so that each person sees only what they need.
- Given I am an admin, When I invite an email with role "assessor", Then they receive an invite and, after accepting, can access only assessments assigned to them or their team.
- Given a user has role "client viewer", When they sign in, Then they see only published reports for their client and cannot edit anything.
- Given any role change, When it is saved, Then an audit log entry records who changed what and when.

**US-1.05 Audit log view** (Should)
As an integrator owner, I want to see an audit log of sign-ins, role changes, exports, and deletions, so that I can answer client security questionnaires.
- Given events have occurred, When I open the audit log, Then I can filter by user, client, event type, and date range.
- Given I am not an owner or admin, When I try to open the audit log, Then access is denied.

**US-1.06 Create a client** (Must)
As an integrator admin, I want to add a client with name, industry, primary contact, and notes, so that assessments are organized by who I deliver them to.
- Given I am an admin, When I save a client with a name, Then it appears in the client list and can hold sites and assessments.
- Given a client name already exists in my workspace, When I save a duplicate, Then I am warned and can proceed or open the existing one.

**US-1.07 Create sites and areas** (Must)
As an integrator admin, I want to add sites (address, site type, criticality) and areas within them (lobby, loading dock, server room), so that findings and photos land in the right place.
- Given a client exists, When I add a site with an address, Then the site appears under that client.
- Given a site exists, When I add areas, Then assessors can pick those areas during capture, and can add new ones on site.
- Given a site has assessments, When I try to delete it, Then I must archive instead; deletion is blocked.

**US-1.08 Bulk import sites** (Could)
As an integrator admin, I want to import sites from a CSV, so that clients with dozens of locations are set up in minutes.
- Given a CSV with name, address, and site type columns, When I import it, Then valid rows are created and invalid rows are listed with the reason.

**US-1.09 Create an assessment** (Must)
As an integrator admin or field assessor, I want to create an assessment for a client and one or more sites with a name, dates, and assigned assessors, so that the field work is planned.
- Given a client with sites, When I create an assessment and select sites and assessors, Then it appears in each assigned assessor's list.
- Given an assessment is created, When it is saved, Then it is in "Draft" status until field work starts.

**US-1.10 Choose any mix of frameworks** (Must)
As an integrator admin, I want to select any combination of CARVER, CPTED, general physical security, NIST CSF 2.0, and PQC readiness for an assessment, so that one visit covers physical and cyber together. (Differentiator; see assumptions above.)
- Given I am creating an assessment, When I tick CPTED and NIST CSF 2.0, Then the walkthrough and control checklist include controls from both, with shared controls shown once.
- Given I select no framework, When I try to save, Then I am asked to choose at least one.
- Given a framework has a version, When I select it, Then the assessment records the exact version used, so later library updates do not silently change past results.

**US-1.11 Framework templates** (Should)
As an integrator admin, I want to save a framework mix and scope as a template ("Retail store, physical plus PQC"), so that repeat engagements start in one tap.
- Given I have a configured assessment, When I save it as a template, Then new assessments can start from it with frameworks and areas prefilled.

**US-1.12 Browse the shared control library** (Must)
As a field assessor, I want to browse and search controls by framework, category, and keyword, so that I can check what a control requires before I write a finding.
- Given the library is loaded, When I search "lighting", Then I see matching controls from every framework that covers it, each showing its framework, reference ID, and version.
- Given a control is marked `needs_review`, When I view it, Then a visible badge says its wording is pending review.

**US-1.13 See cross-framework mappings** (Must)
As a field assessor, I want to see which other framework controls a control maps to, so that I record one finding and it counts everywhere it applies.
- Given a control maps to CPTED and general physical controls, When I open it, Then all mapped controls are listed.
- Given I attach a finding to that control, When I view framework coverage, Then the finding appears under each mapped control.

**US-1.14 Library version notice** (Could)
As an integrator admin, I want to be told when a framework version changes, so that I decide when to move templates to the new version.
- Given a new library version is released, When I open templates, Then I see which templates use an older version and a summary of what changed.

---

## Phase 2: Field capture

**US-2.01 Start a guided walkthrough** (Must)
As a field assessor, I want a guided walkthrough that takes me area by area with the relevant checklist items, so that I do not miss anything and finish faster. (Parity with the EasySet walkthrough as described in the brief.)
- Given an assigned assessment, When I tap "Start walkthrough" and pick a site, Then I see the first area with its checklist items from the selected frameworks.
- Given I am mid-walkthrough, When I close the app and reopen it, Then I return to the same area and item.

**US-2.02 Answer checklist items quickly** (Must)
As a field assessor, I want to answer each item with large buttons (Meets, Partial, Does not meet, Not applicable) and an optional note, so that I can work with gloves and one hand.
- Given a checklist item, When I tap "Does not meet", Then a finding draft is created and linked to that control, and I am prompted for a photo.
- Given any answer button, When measured on a 360 px wide viewport, Then its touch target is at least 48 by 48 px.

**US-2.03 Skip, reorder, and add areas on site** (Should)
As a field assessor, I want to skip an area, come back later, or add an area not in the plan, so that the walkthrough fits the real building.
- Given an area is skipped, When I view progress, Then it is shown as "Skipped" and the assessment cannot be marked complete without a reason or a return visit.
- Given I add an area on site, When I save it, Then it syncs to the site record for future assessments.

**US-2.04 Walkthrough progress** (Should)
As a field assessor, I want to see how many areas and items remain, so that I can manage my time on site.
- Given a walkthrough in progress, When I open the progress view, Then I see completed, skipped, and remaining counts per area.

**US-2.05 Capture a photo** (Must)
As a field assessor, I want to take a photo in the app with one tap, so that evidence is captured without switching apps.
- Given I am on a checklist item or finding, When I tap the camera button, Then the device camera opens and the photo attaches to that item on capture.
- Given the device is offline, When I take a photo, Then it is stored locally and marked "Pending sync".

**US-2.06 Tag a photo** (Must)
As a field assessor, I want each photo assigned to site, area, asset, finding, and control, with asset type, severity, notes, and timestamp, so that the report and register are correct without rework.
- Given I capture a photo from an item, When it is saved, Then site, area, control, and timestamp are prefilled from context.
- Given a photo has no finding, When I view untagged photos, Then it appears in that list until tagged or marked "Context only".
- Given I set severity, When I save, Then severity uses the workspace's scale (default: Low, Medium, High, Critical).

**US-2.07 GPS opt-in** (Must)
As a field assessor, I want GPS recorded only when I allow it, so that sensitive client locations are not leaked by default.
- Given location permission is not granted, When I take a photo, Then no GPS is recorded and nothing nags me more than once per assessment.
- Given I opt in for this assessment, When I take a photo, Then latitude, longitude, and accuracy are stored with it.
- Given a client is flagged "No GPS", When any assessor captures photos for it, Then GPS is never recorded regardless of device setting.

**US-2.08 Batch tag photos** (Should)
As a field assessor, I want to select several photos and apply the same tags, so that I do not tag ten perimeter fence photos one by one.
- Given I select multiple photos, When I set area and asset type, Then all selected photos are updated and individual tags they already had are kept unless I overwrite them.

**US-2.09 Annotate a photo** (Could)
As a field assessor, I want to circle or arrow the issue on a photo, so that the client sees exactly what I mean.
- Given a photo, When I draw an annotation and save, Then the annotated version is used in reports and the original is kept unchanged.

**US-2.10 Claude vision suggestions** (Must)
As a field assessor, I want the app to suggest tags (asset type, area, likely control) and a draft finding from a photo, so that I type less on site. (Differentiator.)
- Given a synced photo, When analysis completes, Then I see suggested tags and a draft finding, each clearly labelled "AI suggestion".
- Given suggestions exist, When I have not acted on them, Then they are not included in scores, reports, exports, or quotes.
- Given the photo is offline, When it later syncs, Then suggestions arrive and I am notified, without blocking capture.

**US-2.11 Accept, edit, or reject suggestions** (Must)
As a field assessor, I want to accept, edit, or reject each AI suggestion individually, so that I stay accountable for every finding.
- Given an AI suggestion, When I tap Accept, Then it becomes a normal tag or finding recorded as "Accepted by Frank, AI-assisted" with a timestamp.
- Given I edit a draft finding, When I save, Then the edited text is stored and the record shows it was AI-assisted and human-edited.
- Given I reject a suggestion, When I tap Reject, Then it is hidden and the rejection is logged; I can optionally say why.

**US-2.12 Explain an AI suggestion** (Should)
As a field assessor, I want to see why the AI suggested a finding (what it saw in the photo, which control), so that I can judge it quickly.
- Given a draft finding, When I tap "Why?", Then I see a short rationale and the control reference it was matched to.

**US-2.13 Work fully offline** (Must)
As a field assessor, I want to run the whole walkthrough, capture photos, and write findings with no signal, so that basements and rural sites are not a problem. (Parity with offline sync as described for Circadian Risk.)
- Given I opened the assessment once while online, When I lose signal, Then I can complete every walkthrough step, capture photos, and edit findings.
- Given I am offline, When I view the header, Then I see an offline indicator and a count of items waiting to sync.

**US-2.14 Background sync and conflict handling** (Must)
As a field assessor, I want my work to sync automatically when signal returns, with no data lost, so that I never re-enter anything.
- Given items are pending, When the device is back online, Then they upload in the background, photos resume after interruption, and the pending count reaches zero.
- Given two assessors edited the same finding offline, When both sync, Then neither edit is lost; the later one is flagged for review with both versions shown.
- Given storage on the device is low, When I try to capture, Then I am warned before capture fails, with how many photos remain pending.

**US-2.15 Low-battery capture mode** (Could)
As a field assessor, I want a low-power mode that defers AI analysis and large uploads, so that my phone lasts the whole site visit.
- Given battery is below 20 percent or I turn the mode on, When I capture, Then photos are compressed for preview, full uploads wait for charging or Wi-Fi, and AI analysis is queued.

---

## Phase 3: Scoring and reports

**US-3.01 Define threat scenarios** (Must)
As a field assessor, I want to define threat scenarios per site (for example forced entry, tailgating, ransomware, harvest-now-decrypt-later) from a starter list or my own, so that risk is scored against real threats.
- Given a site in an assessment, When I add a scenario, Then I can set likelihood and impact on the workspace scale.
- Given CARVER is selected, When I score a target, Then CARVER criteria are captured and feed the scenario's impact.

**US-3.02 Inherent risk** (Must)
As a field assessor, I want inherent risk computed as likelihood times impact per scenario, so that I start from a consistent baseline.
- Given likelihood 4 and impact 5 on a 1 to 5 scale, When I save, Then inherent risk shows 20 and its band (for example High).

**US-3.03 Control effectiveness from findings** (Must)
As a field assessor, I want control effectiveness derived from my checklist answers and findings, so that scores reflect what I actually saw.
- Given a scenario linked to controls, When findings against those controls are accepted, Then control effectiveness updates and shows which findings changed it.
- Given only unaccepted AI suggestions exist, When effectiveness is computed, Then they are ignored.

**US-3.04 Residual risk** (Must)
As a field assessor, I want residual risk calculated from inherent risk and control effectiveness, so that the client sees what risk remains today.
- Given inherent risk and control effectiveness exist, When I view the scenario, Then residual risk is shown with its band.
- Given I change a finding, When I return to the scenario, Then residual risk reflects the change.

**US-3.05 Explain every score** (Must)
As a client stakeholder, I want each score to show how it was calculated and which findings drove it, so that I can defend it to my executives.
- Given any risk score, When I open "How was this calculated?", Then I see the inputs, the formula in plain words, and links to contributing findings and photos.

**US-3.06 Assessor override with reason** (Should)
As a field assessor, I want to override a computed score with a mandatory reason, so that expert judgement is captured transparently.
- Given a computed residual score, When I override it, Then I must enter a reason, and the report shows both values and the reason.

**US-3.07 Assessment dashboard** (Must)
As an integrator admin, I want a dashboard per assessment showing residual risk by scenario, findings by severity, and framework coverage, so that I can review before publishing.
- Given a completed assessment, When I open the dashboard, Then I see a risk heat map, severity counts, and percent of controls assessed per framework.

**US-3.08 Review and publish** (Must)
As an integrator admin, I want to review an assessment and publish it, so that only reviewed work reaches the client.
- Given an assessment with untagged photos or pending AI suggestions, When I try to publish, Then I see what is outstanding and must resolve or explicitly dismiss each.
- Given I publish, When it completes, Then the version is frozen and later edits create a new version.

**US-3.09 Export narrative to Google Docs** (Must)
As an integrator admin, I want to export a branded narrative report with inline photos to Google Docs, so that I can make final edits in a tool my team already uses.
- Given a published assessment and connected Google account, When I export to Docs, Then a Doc is created in my chosen Drive folder with executive summary, scores, findings by area, and inline photos.
- Given AI drafted the narrative, When the Doc is created, Then it contains only text that a human accepted or edited.

**US-3.10 Export findings register to Google Sheets** (Must)
As an integrator admin, I want a findings register, scores, and remediation list in Google Sheets, so that I can sort, filter, and track remediation.
- Given a published assessment, When I export to Sheets, Then tabs exist for Findings (ID, site, area, asset, control references, severity, status, photo links), Scores, and Remediation.

**US-3.11 Photo archive to Google Drive** (Should)
As an integrator admin, I want all photos archived to Drive in folders by site and area, so that evidence is kept with the client file.
- Given a published assessment, When I export photos, Then Drive folders mirror site and area, and file names include finding ID and timestamp.
- Given GPS was not recorded, When photos are exported, Then no location metadata is added.

**US-3.12 Client read-only report view** (Should)
As a client stakeholder, I want to open my published report in the browser without editing rights, so that I can read it and share it internally.
- Given I am a client viewer for this client, When I open the report link, Then I see the published version only, with photos served via expiring signed links.
- Given I am a client viewer, When I try any edit action, Then no edit controls are shown and API writes are rejected.

**US-3.13 Compare two sites** (Should)
As an integrator admin, I want to compare residual risk between two sites of the same client, so that I can tell the client where to invest first.
- Given two published assessments for one client, When I choose Compare, Then I see scenario-by-scenario residual risk side by side, with differences highlighted.

---

## Phase 4: Channel

**US-4.01 Integrator workspace branding** (Must)
As an integrator owner, I want to set my logo, colors, company name, and contact details, so that the app, reports, and quotes look like mine.
- Given I upload a logo and choose colors, When I preview a report, Then my branding appears on the cover, headers, and footers.
- Given a color fails contrast against white text, When I save, Then I am warned and shown an accessible alternative.

**US-4.02 White-label report and quote templates** (Must)
As an integrator owner, I want to control the report cover, disclaimer text, and whether "Powered by Sentinel Assess" appears, within rules set by the product owner, so that clients see my brand first.
- Given my plan allows hiding the platform credit, When I turn it off, Then reports and quotes omit it. (Rules pending: see open questions.)

**US-4.03 Custom domain or embed** (Could)
As an integrator owner, I want the client report view on my subdomain or embedded in my portal by iframe or web component, so that clients stay in my experience.
- Given an embed is configured for an allowed origin, When the report loads inside my portal, Then it renders with my branding and refuses to load on origins not on my list.

**US-4.04 Clients inside my workspace** (Must)
As an integrator admin, I want all my clients, their sites, and assessments in one hierarchy, so that I manage my book of business in one place.
- Given I have many clients, When I open the client list, Then I can filter by industry, last assessment date, and highest residual risk.

**US-4.05 Client logins** (Should)
As an integrator admin, I want to invite client stakeholders as read-only viewers of their own reports, so that I do not email files back and forth. (Depends on the open question about client logins.)
- Given I invite Carmen to client "Acme", When she signs in, Then she sees only Acme's published reports and accepted quotes, nothing of other clients.

**US-4.06 Create a quote from findings** (Must)
As an integrator estimator, I want to select findings and generate a remediation quote with line items, so that an assessment becomes revenue. (Differentiator.)
- Given a published assessment, When I select five findings and choose "Create quote", Then a draft quote is created with one or more line items linked to each finding.
- Given a finding has a remediation recommendation, When it is added, Then the line item description is prefilled from it.

**US-4.07 Product and labor catalog** (Must)
As an integrator estimator, I want a catalog of my products, labor rates, and standard bundles, so that line items are priced consistently.
- Given a catalog entry "Exterior LED wall pack, installed", When I add it to a line item, Then unit cost, unit price, and labor hours fill in from the catalog.
- Given I import a catalog CSV, When it completes, Then invalid rows are listed with reasons.

**US-4.08 Margin control** (Must)
As an integrator owner, I want to set default margins and a minimum margin, so that estimators do not underprice.
- Given a default margin of 35 percent, When an estimator adds items, Then prices are computed at that margin.
- Given a minimum margin of 20 percent, When an estimator goes below it, Then the quote needs owner approval before it can be sent.

**US-4.09 Good, better, best options** (Should)
As an integrator estimator, I want to offer up to three tiers per finding or per quote, so that the client can choose by budget.
- Given a quote with tiers, When the client views it, Then each tier shows total price and which findings it addresses, with my recommended tier marked.

**US-4.10 Projected residual risk per tier** (Could)
As a client stakeholder, I want to see how residual risk would change under each quote tier, so that I can justify the spend.
- Given a tier addresses specific findings, When I view the tier, Then I see projected residual risk if those findings were remediated, labelled "Projected, not assessed".

**US-4.11 Export and send the quote** (Must)
As an integrator estimator, I want to export the quote to Google Sheets and a branded PDF or Doc, so that it fits my existing sales process.
- Given a ready quote, When I export to Sheets, Then line items, tiers, subtotals, tax placeholder, and totals are in the sheet; internal cost and margin are on a separate tab I can omit.
- Given I send to the client, When the client opens it, Then internal cost and margin are never visible.

**US-4.12 Quote status tracking** (Should)
As an integrator owner, I want quote statuses (Draft, Sent, Accepted, Declined, Expired), so that I can see conversion from assessments to work.
- Given quotes exist, When I view the quote list, Then I can filter by status and see total value per status.

**US-4.13 Portfolio comparison across sites** (Must)
As an integrator admin, I want to compare residual risk across all sites of a client, so that I can show a portfolio view and prioritize. (Parity with portfolio comparison as described for Circadian Risk.)
- Given a client with several published assessments, When I open Portfolio, Then I see sites ranked by residual risk, with filters by framework and scenario.
- Given an assessment used an older framework version, When it appears in the portfolio, Then it is flagged so comparisons are not misleading.

**US-4.14 Trend over time** (Could)
As a client stakeholder, I want to see how a site's residual risk changed between assessments, so that I can see whether remediation worked.
- Given two or more published assessments of one site, When I open its history, Then I see residual risk per scenario over time.

---

## Field reality checklist

Every Phase 2 screen must pass this before qa-security-reviewer sign-off. Test on a mid-range Android and an iPhone, at 360 px and 390 px widths.

- Gloves: primary actions have touch targets of at least 48 by 48 px with 8 px spacing; no swipe-only or long-press-only actions; no small toggles for critical choices.
- Sun glare: a high-contrast mode; text contrast at least 7:1 for capture screens; severity shown by label and icon, never color alone.
- No signal: every capture flow works offline; a visible offline indicator and pending-sync count; no spinner that blocks capture while waiting for the network; AI suggestions arrive later without blocking.
- One-handed use: camera, answer buttons, and "Next" sit in the bottom third of the screen; forms are tappable choices first, typing last; voice dictation works in note fields.
- Battery: no continuous GPS; AI analysis and full-size uploads can wait for Wi-Fi or charging; the screen does not need to stay awake except in camera view.
- Interruptions: a phone call, app switch, or crash never loses a photo or a half-written finding; drafts save on every change.
- Speed: a photo can be captured and tagged to a finding in three taps or fewer from the walkthrough screen.

---

## Findings-to-quote design sketch (Phase 4)

### Flow
1. Estimator opens a published assessment and selects findings (filter by severity, site, or framework).
2. "Create quote" builds a draft with one line item group per finding, prefilled from the finding's remediation text.
3. Estimator adds catalog items, labor, and tiers; margin rules apply.
4. Owner approval if below minimum margin.
5. Export or send; client accepts or declines; status is tracked.

### Line item fields

| Field | Notes |
|---|---|
| Line ID | Auto. |
| Linked findings | One or more finding IDs; a finding can appear in several line items. |
| Site and area | Inherited from the finding; editable. |
| Description | Client-facing; prefilled from remediation text. |
| Type | Material, Labor, Subcontract, Other. |
| Catalog item | Optional link to catalog for SKU, manufacturer, model. |
| Quantity and unit | For example 4 each, 12 hours. |
| Unit cost | Internal only. |
| Margin percent or unit price | Either one drives the other. |
| Extended price | Quantity times unit price. |
| Tier | Good, Better, Best, or All tiers. |
| Optional flag | Shown to client as optional add-on. |
| Internal notes | Never exported to the client. |

### Labor and materials
- Labor lines use workspace labor rates by role (technician, programmer, project manager), with hours and an optional after-hours multiplier.
- Material lines come from the catalog or are entered ad hoc; ad hoc items are flagged for catalog review.
- Bundles combine materials and labor (for example "Camera, mount, cable run, programming") and expand into lines on demand.

### Margin
- Workspace default margin, per-category overrides (materials, labor, subcontract), and a minimum margin that triggers owner approval.
- Quote summary shows cost, price, and blended margin to internal users only.

### Good, better, best tiers
- Tiers are optional; a quote with none is a single option.
- Each tier lists which findings it addresses fully, partially, or not at all.
- The recommended tier is marked; Could: projected residual risk per tier (US-4.10).

### Export
- Google Sheets: client tab (lines, tiers, totals) and internal tab (cost, margin); the internal tab is omitted when sharing externally.
- Branded Google Doc or PDF: cover, scope, findings addressed with thumbnail photos, tier comparison, terms, validity date.
- Assumption: integrators will want a CSV for their own PSA or accounting tools; which tools is an open question.

---

## Open product questions for CW

1. Pricing model: per integrator seat, per assessment, per site, or a platform fee plus usage? Are AI vision calls metered separately?
2. Do client stakeholders get logins (US-4.05), or do they only receive exported reports? If logins, are they free for the integrator?
3. Report branding rules: may integrators remove "Powered by Sentinel Assess" entirely, on all plans or only higher tiers? Can they use a custom domain?
4. Can a client be shared between two integrators (for example a client that switches provider), and who owns the historical data?
5. Default risk scales: 1 to 5 likelihood and impact, or configurable per workspace? Configurable scales make portfolio comparison harder.
6. Should AI-drafted narrative text be disclosed in client reports (for example "prepared with AI assistance, reviewed by a named assessor")?
7. Photo and GPS retention: how long do we keep photos and location data by default, and can clients demand deletion?
8. Quote scope: is the quote a proposal only, or should Phase 4 include acceptance signatures and tax handling?
9. Which PSA or accounting tools (if any) must quotes export to first?
10. Are ASIS standards or ISO 27001 needed by any launch integrator, which would change Phase 1 library priorities?
11. Competitive claims: before any marketing uses "parity" or "differentiator" language, who verifies what EasySet and Circadian Risk actually do today? The statements in this document are assumptions.
