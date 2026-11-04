# Phase 1 UX review: field assessor and integrator view

Owner: channel-product-manager. Date: 2026-11-04. Status: for the Head of Engineering and CW.

Scope: the Phase 1 PWA (sign in, clients and sites, new assessment wizard, framework picker, control library, assessment detail) reviewed against the Phase 1 stories and the Field reality checklist in `docs/user-stories.md`.

Evidence used:
- Screenshots: `docs/screenshots/phase1-live-framework-picker.png`, `docs/screenshots/phase1-live-control-detail.png`, `apps/web/screenshots/framework-picker.png`, `apps/web/screenshots/control-detail.png`.
- Screens and components: `apps/web/src/screens/*.tsx`, `apps/web/src/components/*.tsx`, plus `App.tsx` routes and the API route list in `apps/api/src/routes/`.
- Library data: the five framework files in `packages/frameworks/data/frameworks/` and all 176 questions in `packages/frameworks/data/controls/`.

Limits: I did not run the app, so touch sizes and contrast are judged from Tailwind classes and screenshots, not measured on a device. Where a story depends on database behavior (tenant isolation), I note what the routes suggest and do not claim it is verified.

Note on screenshots: `apps/web/screenshots/` is stale. It shows placeholder mapping titles ("SA-LGT-1: Requirement SA-LGT-1") and older counts (Physical security 24 requirements, CPTED 6). The `docs/screenshots/` set reflects current data. Use only the docs set in reviews and demos.

---

## 1. Phase 1 story status

| Story | Status | Evidence |
|---|---|---|
| US-1.01 Sign in with Google | Partly met | `SignIn.tsx` has "Sign in with Google" and the exact "No workspace found; ask your administrator for an invite." copy. But email and password is the primary form and Google is a secondary button below an "or" divider, with a generic circle icon. Sign out clears wizard drafts (`AuthContext.signOut`), but the cached framework library stays readable on the device; "cached data is locked" is not shown to be met. |
| US-1.02 Revoke sessions | Not met | No revoke endpoint in `apps/api/src/routes/` and no admin screen. |
| US-1.03 Create a workspace | Partly met | All tenant routes are scoped by role and tenant; workspace choice appears at sign in for multi-workspace users. There is no screen to create a workspace. Database-level isolation not verified in this review. |
| US-1.04 Invite users and roles | Not met | Roles are enforced by the API (`role("admin")`, `role("assessor")`) and a 403 shows "Your role cannot do this. Ask an admin." There is no invite flow and no role management screen. |
| US-1.05 Audit log view | Partly met | `GET /audit` exists and is admin-only. No screen, no filters by user, client, event type, or date. |
| US-1.06 Create a client | Partly met | Name, industry, notes, and the duplicate warning with "Open existing" and "Save anyway" are all met. Primary contact is missing. |
| US-1.07 Sites and areas | Partly met | Sites with name, address, and type are met. Criticality, areas, and archive instead of delete are missing. Areas are a prerequisite for the Phase 2 area-by-area walkthrough. |
| US-1.08 Bulk import sites | Not met | Could; not started. |
| US-1.09 Create an assessment | Partly met | Three-step wizard: client and site, frameworks, title and date. Only one site per assessment, one date, and no assessor assignment, so "appears in each assigned assessor's list" cannot be met. Status chip supports Draft. |
| US-1.10 Any mix of frameworks | Met | Any combination, three presets, "Choose at least one framework." on Next, versions pinned at creation ("Frameworks (pinned versions)", "Later library updates do not change this assessment."), and shared controls counted once in the summary. The walkthrough half of the first criterion is Phase 2. |
| US-1.11 Framework templates | Not met | Presets are hard-coded in `coverage.ts`; integrators cannot save their own. |
| US-1.12 Browse the library | Met | Search with debounce, framework and domain filters, result count, "Wording pending review" badge, framework and version chips. Framework reference IDs show on the detail screen, not in the list. |
| US-1.13 Cross-framework mappings | Partly met | "Counts toward" lists every mapped requirement with its relationship (Satisfies, Supports, Informs). The second criterion (a finding appears under each mapped control) needs findings, which arrive in Phase 2. |
| US-1.14 Library version notice | Not met | Could; not started. |

Field reality checklist (applies formally to Phase 2, checked early here):

| Check | Phase 1 status |
|---|---|
| Gloves: 48 px targets, 8 px spacing, no tiny toggles | Pass on the evidence: buttons, radio cards, framework cards, and nav items use `min-h-14` (56 px) with whole-card tap areas and `gap-2` or more. |
| Sun glare: high-contrast mode, 7:1 on capture screens, severity not color alone | Partly: framework category and review state use text labels plus color; no high-contrast mode yet. |
| No signal | Partly: offline banner and cached library work, but the wizard can be completed offline and only fails at "Create assessment". No pending count yet (Phase 2). |
| One-handed: actions in the bottom third | Pass: bottom nav and a sticky Back and Next bar. |
| Interruptions: drafts save on every change | Pass for the wizard (IndexedDB draft on every change). Fail on sign out, which deletes drafts with no warning. |

---

## 2. Prioritized UX issues

### P1: must fix before the field pilot

**P1-1. Framework picker descriptions are written for engineers, not assessors.**
- Screen: New assessment, step 2 (`FrameworkPicker`), data in `frameworks/*/1.0.0.json` `description`.
- Problem: cards say "see decision D-007", "this file was entered without access to the source PDF and every item is flagged for verification against CSWP 29 Appendix A", "many are paywalled". This is internal provenance. It makes the step 2 screen about 8,700 px tall on a phone (live screenshot) and tells a client looking over the assessor's shoulder that the content is unverified.
- Fix: add a `summary` field (one line, under 90 characters) per framework for the picker and keep the long `description` and source notes on a library "About this framework" page. Suggested summaries are in section 3.

**P1-2. "N items need expert review" on every framework, every item.**
- Screen: framework picker, control detail badge.
- Problem: all 228 requirements across the five frameworks are `needs_review`. A warning that is always on is ignored, and in front of a client it undermines the integrator's credibility. The honest state is real, the presentation is the problem.
- Fix: this is a product decision for CW, so I am escalating it. Options: (a) complete SME review of at least the physical frameworks before the pilot; (b) replace per-card warnings with one library-level notice ("Library 1.0 wording is pending expert review; see About") and keep the per-control badge only in the library, not in client-facing views. Either way, reports must carry the disclosure until review is done.

**P1-3. Coverage summary is hard to read and sits out of view.**
- Screen: framework picker summary card and step 3 review.
- Problem: "3 frameworks selected: 98 shared controls to check, 48 of them count toward more than one framework." followed by "Shared controls 98, Overlapping 48, Questions 172". An assessor wants to know how big the job is. "Shared" and "Overlapping" mean the same thing to a field user, and the card is below five long framework cards, so the effect of a tap is invisible.
- Fix: put a one-line live summary in the sticky bottom bar above Next: "3 frameworks · 172 questions · 98 controls". Rename "Shared controls" to "Controls to check" and "Overlapping" to "Count toward 2 or more". Later, add "about N hours on site" once we have timing data from the pilot (assumption: we do not have that data yet, so do not invent a per-question time).

**P1-4. Sign out deletes drafts with no warning, and the button is a large target in the header.**
- Screen: `AppShell` header; `AuthContext.signOut`.
- Problem: one gloved mis-tap on "Sign out" ends the session and calls `clearDrafts()`. Today that loses a half-finished wizard; in Phase 2 the same path would risk unsynced field work, which breaks the Interruptions rule.
- Fix: move Sign out into an account menu (workspace name, switch workspace, sign out). If any drafts or pending items exist, confirm with "You have 1 unfinished assessment on this device. Signing out deletes it. Sign out anyway?" with "Keep working" as the default button.

**P1-5. NIST CSF 2.0 requirement titles are generated, not real.**
- Screen: control detail, "Counts toward" (live screenshot shows "PR.AA-06: Identity Management, Authentication, and Access Control 06").
- Problem: CSF subcategories do not have titles; the data fills `title` with "category name + number" (for example "Organizational Context 01"). It reads like a bug to anyone who knows CSF.
- Fix: for subcategory-level requirements, show "PR.AA-06" plus the outcome text ("Physical access to assets is managed, monitored, and enforced commensurate with risk"), truncated to two lines with "More". Mark the data change for the frameworks owner.

**P1-6. No areas and no assessor assignment.**
- Screen: client detail (sites), wizard step 1 and 3.
- Problem: US-1.07 areas and US-1.09 assessor assignment are missing. Phase 2 is a walkthrough "area by area" that appears in the assigned assessor's list. Without these, the pilot has no structure and every assessor sees every assessment.
- Fix: add an Areas list to each site (tap choices from a starter set: Lobby, Loading dock, Server room, Perimeter, Parking, Roof, plus "Add area"), and an "Assessors" step in the wizard (checkbox cards of workspace members with role assessor). Filter "Assessments" to "Assigned to me" by default for assessors.

**P1-7. The wizard can be completed offline and then fails at the last tap.**
- Screen: New assessment, all steps; `OfflineBanner`.
- Problem: the banner says "New records need a connection in this release", yet the wizard lets the user pick frameworks and type a title, then shows a network error on "Create assessment". The draft is kept, but the user is not told that.
- Fix: when offline on step 3, change the button to "Save draft, create when online" and show "Your draft is saved on this device. We will create the assessment when you are back online." If queuing is out of scope for Phase 1, at least show that message and keep the button disabled with the reason, not a raw error.

### P2: fix before general release

**P2-1. Draft is restored silently.** Wizard opens on whatever step the last draft was on, with no notice and no way to start fresh. Fix: a banner on open, "Continuing your unfinished assessment for Acme, HQ" with "Start over".

**P2-2. Errors appear at the top while the action is at the bottom.** On step 1, tapping Next without a site puts "Choose a site." in a banner that may be scrolled off screen. Fix: show the error inline next to the Site fieldset and scroll to it, and repeat it in the sticky bar.

**P2-3. Two stacked bottom bars eat the screen.** In the wizard, the sticky Back and Next bar sits on top of the bottom nav (about 136 px together, roughly a fifth of a 640 px tall viewport). The full-page live control-detail screenshot also shows the nav over content. Fix: hide the bottom nav during the wizard (the header back link covers exit), and confirm `pb-24` clears the nav on every long screen.

**P2-4. Control detail order does not match field use.** The assessor needs the questions and evidence first; mappings are for the report. Fix: order Objective, Questions, Evidence to collect, then "Counts toward" collapsed by default with its summary line visible.

**P2-5. Mapping cards repeat the same help text.** "Satisfies: This control fully addresses the requirement." appears on every mapping. Fix: use a short chip ("Fully counts", "Partly counts", "Feeds score") and one legend line under the "Counts toward" heading. Hide the rationale behind "Why?" when it only restates the titles.

**P2-6. Questions do not show how they will be answered.** The library shows question text and guidance only. Fix: show the answer type and unit under each question: "Answer: Yes, Partial, No, N/A", "Answer: number of doors (0 expected)", or the scale anchors. Show the camera icon when `photoOnDeficiency` is true.

**P2-7. Google sign in is secondary and unbranded.** Fix: put "Sign in with Google" first as the primary button, using Google's published sign-in button mark; keep email and password under "Other ways to sign in".

**P2-8. Integrator setup gaps.** Client primary contact (US-1.06), site criticality (US-1.07), user invites (US-1.04), and an audit log screen (US-1.05) are needed before an integrator can run the pilot without our help. Fix: add these as admin-only screens; criticality as three tap choices (Standard, Elevated, Critical), not free text.

**P2-9. Assessment detail is a dead end.** It ends with "The guided walkthrough and photo capture arrive in Phase 2." Fix for the pilot build: show what the admin can do next (edit scope, assign assessors, open the control checklist for this assessment) and hide release-stage wording from end users.

**P2-10. Saved templates.** Integrators repeat the same scope per client type. Fix: "Save as template" on step 3 and "Start from a template" on step 2 above the fixed presets (US-1.11).

### P3: polish

**P3-1. Version chips are ambiguous.** "NIST CSF 2.0 v1.0.0" mixes the standard's edition with our library version. Fix: "NIST CSF 2.0 (Feb 2024), library 1.0.0" on detail screens; keep "v1.0.0" only on the review step.

**P3-2. "Selected" text next to a checked box** is redundant visually but helps when color is washed out; keep it, but drop it in the CPTED card where it wraps onto the badge row at 360 px.

**P3-3. Library list shows control IDs (SC-ACC-001) first.** Assessors scan by title. Fix: title first, ID and domain in the muted line below.

**P3-4. Preset order differs from card order.** "Physical site survey" lists Physical security, CPTED, CARVER; cards list CARVER first. Fix: sort cards physical-general, CPTED, CARVER, NIST CSF 2.0, PQC.

**P3-5. Stale screenshots in `apps/web/screenshots/`.** Replace or delete them so no one demos placeholder titles.

---

## 3. Question wording: are questions objective and answerable on site?

Sample: all 176 questions (114 Yes, Partial, No, N/A; 59 numeric, all with a `unit`; 3 scales with anchors). 52 prompt for a photo on deficiency.

What works:
- Most are observable or measurable with a clear pass line: "Is the gap between the bottom of the fence and grade 2 in (5 cm) or less along the full run, including at washouts?"; "Measured time from holding a controlled door open until the held-open alarm is raised" (seconds, with "Use a stopwatch").
- Guidance usually tells the assessor how to check and what Partial means: "Try each door from outside. Partial: one door found unlocked with a documented reason."
- Numeric questions state the expected result where it is known: "0 is the expected result."
- Scales have concrete anchors (crypto inventory: None, Partial, System level, ...).

Problems and fixes:
1. 33 of 114 Yes, Partial, No questions have no Partial definition, for example Q-LGT-002-01 (unlit gaps between fixtures), Q-VSS-002-01 (full perimeter and parking coverage), Q-LCK-003-01 (non-removable hinge pins). Two assessors will score these differently. Fix: add "Partial: ..." to each, or change to Yes, No, N/A when Partial has no meaning (for example Q-CRY-005-02 "Is TLS 1.3 enabled on externally facing services?" could be numeric: percent of services).
2. Compound questions hide two checks in one answer: Q-ENV-005 ("Is there a written maximum time ... and was it met for the last 3 incidents?"), Q-VSS-002-01 (coverage, overlap, and no blind spots), Q-PER-003-02 (three gap locations). Fix: split where the parts can fail independently, or define Partial as "one part met".
3. Ten guidance strings contain "(unverified)", for example the DORI pixel density figures in Q-VSS-001. That is a data-quality note, not field guidance. Fix: move it to the citation `note` and keep it out of field-facing text.
4. Many cyber and policy questions are answered from documents or interviews, not by walking the site (patch medians, tabletop dates, backup immutability). Fix: tag each question with a method (Walk, Measure, Ask, Document) so the Phase 2 walkthrough can group "Ask" and "Document" items into one interview block instead of interrupting the site walk.
5. Some need tools or calculations: tape measure (fence gaps, latch gap 1/8 in), stopwatch, a camera test target or a pixel-density calculation (Q-VSS-001). Fix: generate a "Bring on site" list per assessment from the selected controls, and offer a simple pixel-density calculator (resolution, lens, distance) rather than expecting mental math on site.
6. Date-sensitive wording: Q-CRY-009-02 cites 2035 from the IR 8547 draft. Fine for now; flag it for the library version notice (US-1.14) when the final IR publishes.

---

## 4. Copy changes

| Where | Current | Proposed |
|---|---|---|
| CARVER card | "CARVER scores each target ... (see decision D-007). The anchors are Sentinel paraphrases adapted for facility security." | "Scores each critical asset on six criteria to show what an adversary would target first." |
| CPTED card | "First-generation CPTED principles ... All text is a Sentinel paraphrase; codes are Sentinel codes." | "Site design checks: sightlines, access, territory, maintenance, and activity." |
| Physical Security card | "Sentinel general physical security checklist organized by area ... many are paywalled." | "Perimeter, doors and access, cameras, alarms, locks, lighting, guards, and policy." |
| NIST CSF 2.0 card | "The CSF 2.0 Core ... this file was entered without access to the source PDF ..." | "Cyber outcomes across Govern, Identify, Protect, Detect, Respond, and Recover." |
| PQC Readiness card | "A readiness model for migrating ... they are not quoted from them." | "Crypto inventory, quantum-vulnerable algorithms, and migration plan (FIPS 203, 204, 205)." |
| Picker card footer | "! 134 items need expert review" | Remove from cards; one library notice: "Library 1.0 wording is pending expert review. About the library" |
| Picker summary | "3 frameworks selected: 98 shared controls to check, 48 of them count toward more than one framework." | "3 frameworks · 172 questions · 98 controls (48 count toward 2 or more)" |
| Summary labels | "Shared controls", "Overlapping" | "Controls to check", "Count toward 2 or more" |
| Review step | "Deduplicated: N checks saved, because ..." | "You check N fewer controls because one finding counts in several frameworks." |
| Offline banner | "Saved library data still works. New records need a connection in this release." | "You are offline. You can browse the library. Drafts are saved on this device; creating clients and assessments needs a connection." |
| Mapping relationship | "Satisfies: This control fully addresses the requirement." | Chip "Fully counts" with legend "Fully counts: a finding here fully covers this requirement." |
| NIST mapping title | "PR.AA-06: Identity Management, Authentication, and Access Control 06" | "PR.AA-06: Physical access to assets is managed, monitored, and enforced commensurate with risk" |
| Assessment detail footer | "The guided walkthrough and photo capture arrive in Phase 2." | Remove for pilot users; replace with next actions. |
| 403 message | "Your role cannot do this. Ask an admin." | "Only an admin can add clients and sites. Ask your admin, or sign in with an admin account." (name the action) |
| Sign out | Immediate | Confirm when drafts exist: "Signing out deletes 1 unfinished assessment on this device. Keep working / Sign out anyway" |

---

## 5. Keep these

- Large tap targets everywhere: 56 px buttons, whole-card tap areas for radio and checkbox cards, bottom nav, sticky Back and Next in the thumb zone.
- Text plus color for state: "Physical" and "Cyber" labels, "Selected" text, "!" prefixes on warnings, check marks on completed steps.
- Wizard drafts saved to IndexedDB on every change, and focus moved to the step heading on each step for screen readers.
- Version pinning shown in plain words: "Later library updates do not change this assessment."
- The "Counts toward" concept and the "A finding on this control counts toward 4 requirements in 4 frameworks" line: it is the clearest expression of our converged physical and cyber story and sells well to integrators.
- Duplicate client warning with "Open existing" and "Save anyway".
- Offline library cache with "Showing the library saved on this device."
- Field-grade question writing in the physical domains: measurable thresholds in both imperial and metric, "how to check" guidance, explicit Partial rules, and photo prompts on deficiency.
- Friendly, specific Google sign-in error messages.

---

## Open items for the Head of Engineering and CW

1. P1-2 is a product decision: complete SME review before the pilot, or ship with a single library-level disclosure. Recommend at least physical-general, CPTED, and CARVER reviewed before any client sees a report.
2. P1-6 (areas, assignment) and P1-7 (offline create) may be scoped as Phase 2 work; if so, the pilot should start no earlier than Phase 2.
3. P1-5 and question fixes in section 3 are data changes in `packages/frameworks`, outside my lane; filed here for the frameworks owner.
