# @sentinel/frameworks: versioned framework library

This package holds the Sentinel Assess framework library as JSON data, plus the loader and integrity checks. The contract is the zod schemas in `packages/shared/src/frameworks.ts` (decisions D-005 to D-007).

## Layout

```
data/
  controls/<DOMAIN>.json          SharedControlLibrary: one file per domain (16 files)
  frameworks/<id>/<version>.json  FrameworkVersion: one file per framework version
  crosswalk.json                  Crosswalk: shared control -> framework requirement
  walkthrough.json                Walkthrough: field order of sections, asset type -> likely controls
CHANGELOG.md                      every library release and every changed question id
src/
  index.ts                        loadLibrary(), checkIntegrity(), checkWalkthrough(), crosswalk queries
  validate-cli.ts                 npm run validate:frameworks
  library.test.ts                 Vitest content tests
```

Library 1.1.0 contents (see CHANGELOG.md for what changed from 1.0.0):

| Layer | Count |
|---|---|
| Shared controls | 101 (physical: PER 6, ACC 7, VSS 7, IDS 6, LCK 6, LGT 6, GRD 6, POL 7, ENV 7; cyber: GOV 6, IDN 6, PRT 7, DET 5, RSP 5, RCV 4; CRY 10) |
| Questions | 184 (yes/partial/no/N/A, number with unit, or anchored scale; no free text). Every yes/partial/no/N/A question defines Partial in its guidance |
| Frameworks | nist-csf-2 (6 functions, 22 categories, 106 subcategories), pqc-readiness (8 pillars, 13 requirements), cpted (6 principles, 17 strategies), carver (6 criteria with 1 to 10 scales), physical-general (8 areas, 36 requirements) |
| Walkthrough | 11 sections in field order covering all 16 domains once; `assetTypeControls` for all 23 asset types |
| Crosswalk | 272 entries: 118 satisfies, 119 supports, 35 informs; 75 controls count toward 2 or more frameworks, 22 toward 3 or more |

### The three layers

1. **Shared controls** own the questions. A control is one thing an assessor can observe or verify (for example "Restricted area segregation"). Ids are `SC-<DOMAIN>-<NNN>`, questions `Q-<DOMAIN>-<NNN>-<NN>`.
2. **Framework versions** own requirements and citations. Codes are the source's own codes where it has them (NIST CSF `PR.AA-06`) and Sentinel codes prefixed `SA-` where it does not (`SA-PQC-INV-01`, `SA-CPTED-NS-02`, `SA-CARVER-A`, `SA-PHY-ACC-05`).
3. **Crosswalk** joins them with a relationship and a rationale:
   - `satisfies`: answering the control's questions fully evidences the requirement.
   - `supports`: partial evidence; other controls are also needed.
   - `informs`: evidence feeds an analysis rather than meeting a requirement. Used only for CARVER (D-007): physical and cyber controls inform Accessibility, Vulnerability, Recognizability, and, for inventory and recovery controls, Criticality, Effect, and Recuperability.

Example of one control counting toward several frameworks: `SC-ACC-005` (restricted area segregation) satisfies `physical-general SA-PHY-ACC-05` and `nist-csf-2 PR.AA-06`, supports `PR.AA-05`, and informs `carver SA-CARVER-A`.

CARVER codes: `SA-CARVER-C` Criticality, `SA-CARVER-A` Accessibility, `SA-CARVER-REC` Recuperability, `SA-CARVER-V` Vulnerability, `SA-CARVER-E` Effect, `SA-CARVER-RCG` Recognizability. Anchors are banded 1 to 2, 3 to 4, 5 to 6, 7 to 8, 9 to 10; the anchor `value` is the lower bound of each band.

Units: distances are in feet with metric in the question text, illuminance in lux (1 fc = 10.76 lux), pixel density in px/m.

### Walkthrough

`data/walkthrough.json` orders the guided field walk (API: `GET /assessments/:id/walkthrough`). Sections follow the route an assessor walks: arrival and perimeter (PER, ENV), parking and exterior lighting (LGT, needs a night visit), entrances and access control (ACC), building envelope (LCK), interior and intrusion detection (IDS), video surveillance (VSS), security operations and guards (GRD), policies and records interview (POL), IT and server room (PRT, IDN, DET), cyber governance interview (GOV, RSP, RCV), cryptography and PQC interview (CRY). Each description tells the assessor what to bring, when to go, and what to request in advance.

Rules, enforced by `checkWalkthrough()`: every domain is in exactly one section; section ids and `order` values are unique; `assetTypeControls` has a key for every `AssetType` and lists only existing shared controls; `libraryVersion` equals the crosswalk's. `assetTypeControls` is derived from each control's `assetTypes` plus a few additions (gate, server room, barrier); it feeds candidate controls to the photo model.

## Working with the library

```
npm run validate:frameworks                 # schema + integrity
npx vitest run --root packages/frameworks   # content tests
npx tsc --noEmit -p packages/frameworks
```

### Changing content (versioning practice)

Phase 1 is signed off (D-026), so every content change publishes a new version and is recorded in `CHANGELOG.md`. Assessments pin the library release and framework versions they used (D-023).

- Wording fix or new citation note: patch (`1.0.1`).
- New requirement, control, or question, or a split question: minor (`1.1.0`).
- Removed or re-coded requirement, removed question, changed scale or answer type: major (`2.0.0`).

Library release: the control files, `crosswalk.json`, and `walkthrough.json` share one `libraryVersion` (tests enforce this); bump all of them together. Framework files are versioned on their own: write the new version next to the old one (`data/frameworks/nist-csf-2/1.1.0.json`) and keep the old file. The loader accepts several versions of one framework; the crosswalk references requirement codes by framework id, so a re-coded major version needs a crosswalk review.

Question ids:

- Keep the id when the meaning is unchanged (guidance edits, clearer wording).
- When splitting a compound question, the original id keeps the first part and the other parts get the next free numbers in that control.
- Never reuse an id for a different meaning; retire it instead.
- List every added or changed id in `CHANGELOG.md`.

Field guidance style: yes/partial/no/N/A questions say `Partial: ...`; thresholds that are not confirmed against a source say `Target to confirm: ...`, never "(unverified)".

### Adding a framework (ASIS, ISO 27001)

1. Create `data/frameworks/<id>/1.0.0.json` with a `kind` (`control_framework` for ISO 27001 Annex A, `assessment_checklist` or `control_framework` for ASIS standards) and `levels` (for ISO 27001: `theme`, `control`).
2. Use the source's identifiers (ISO 27001:2022 Annex A `A.5.1`) only after checking them against a licensed copy. ISO and ASIS text is copyrighted: paraphrase, set `citation.verified` only when a human has checked the section number, and never paste the standard's wording.
3. Add crosswalk entries from existing shared controls first; add new shared controls only where nothing existing fits.
4. Add the framework id to the "has all frameworks" test.

## Citation policy

- Cite document, edition, and section or identifier for every requirement and control reference.
- `verified: true` only when the wording and section were checked against the source. Nothing in 1.0.0 or 1.1.0 is verified: the build container could not reach nist.gov or any standards body.
- Paywalled sources (ISO, ASIS, IEC, UL, NFPA, IES, BHMA) are always paraphrased.
- Requirement `status` is `needs_review` whenever its citation is unverified. Shared controls are all `needs_review`; none is `approved` until a human expert reviews it.
- Sentinel-authored requirements (PQC, CPTED, CARVER, physical-general) say in their citation note that they are derived from the source, not quoted.
- House style: no em dashes in any data file (enforced by test).

## Flagged and unverified items

| Item | Flag | Action needed |
|---|---|---|
| nist-csf-2, all 134 items | Text entered from knowledge; nist.gov unreachable | Check every function, category, and subcategory against CSWP 29 Appendix A, then set `verified: true` and `status: verified` |
| nist-csf-2 GV.OC-03 | Source uses a dash-delimited aside; rewritten with commas for house style | Confirm acceptable deviation from official text |
| nist-csf-2 GV.RR-03, PR.IR-04 | Official text contains "Adequate"; kept as quoted | None (question heuristic applies to questions only) |
| pqc-readiness, all requirements | Sentinel requirements derived from sources; section names, not numbers, for FIPS 203, 204, 205 | Add FIPS section numbers (parameter set sections) after checking the PDFs |
| NIST IR 8547 | Initial public draft (Nov 2024); 2030 deprecation and 2035 disallowance dates | Check for a final version and any date changes; update SA-PQC-MIG-01 and Q-CRY-009-02 (guidance says "Target to confirm") |
| CNSA 2.0 | Cited for AES-256 and SHA-384/512 and timelines; applies to National Security Systems | Confirm current advisory version |
| SA-PQC-TST-02 | CAVP and CMVP program references | Confirm program names and current FIPS 140-3 guidance |
| SA-PQC-DATA-01 | Lifetime vs. threat horizon method (Mosca) is a Sentinel method | None; already labeled |
| cpted, all requirements | ISO 22341:2021 paywalled; paraphrase of ISO and CPTED literature | Expert check of strategy wording against ISO 22341 clauses; add clause numbers |
| cpted SA-CPTED-2G-* | Second-generation concepts (Saville and Cleveland 1998); only partly assessable on site | Product decision whether to show by default |
| cpted SA-CPTED-MM-01 | Broken windows theory is contested | Note in reports |
| carver, all 6 criteria and anchors | Anchors paraphrased and adapted from FM 34-36 App. D, ATP 3-05.20, FDA CARVER + Shock primer; not checked | Check doctrine edition and section; confirm the adaptation of military anchors to facilities |
| physical-general, all requirements | Sources mostly paywalled (ASIS PAP.1-2012, IEC 62676-4, UL 2050, NFPA 731, BHMA A156, IES G-1, IES RP-20) | Expert check; confirm current editions; NFPA 731 consolidation status |
| IEC 62676-4 DORI values (25, 62, 125, 250 px/m) | From memory | Check table in the standard |
| UFC 4-022-03 thresholds (7 ft fence, 96 sq in openings, 2 in ground gap) used in guidance | From memory | Check against current UFC |
| CPTED landscaping rule (3 ft shrubs, 7 ft canopy) in Q-ENV-002-01 | Common practice, varies by jurisdiction | Make configurable per client if needed |
| ACC, LGT, VSS timing and retention targets (24 h revocation, 30 day video, 72 h repair) | Common practice, not from a cited standard; questions record measured values | Confirm defaults with CW |
| All 101 shared controls | `status: needs_review` | Human expert review before `approved` |
