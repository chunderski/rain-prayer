# Framework library changelog

Library releases cover the shared control files (`data/controls/*.json`), `crosswalk.json`, and `walkthrough.json`, which always carry the same `libraryVersion`. Framework files (`data/frameworks/<id>/<version>.json`) are versioned on their own and are listed only when their content changes.

## 1.1.0 (2026-11-05)

Field review fixes from docs/ux-review-phase1.md section 3, published after Phase 1 sign-off (D-026). Framework files are unchanged and stay at 1.0.0. The crosswalk content is unchanged apart from its `libraryVersion`.

### Added

- `data/walkthrough.json`: 11 walkthrough sections in field order, each of the 16 domains in exactly one section, and `assetTypeControls` for all 23 asset types.
- New questions (second half of a split compound question; the original id keeps the first half):

| New id | Split from | Asks |
|---|---|---|
| Q-ENV-005-03 | Q-ENV-005-02 | Was the written graffiti and vandalism repair time met for the last 3 incidents? |
| Q-GOV-003-03 | Q-GOV-003-02 | Was the risk register updated in the last 6 months? |
| Q-GRD-006-03 | Q-GRD-006-01 | Were the 5 sampled incident entries reviewed by a supervisor within 24 hours? |
| Q-IDS-005-02 | Q-IDS-005-01 | Was every panic or duress button tested in the last 12 months, with a record? |
| Q-LGT-004-03 | Q-LGT-004-02 | Was the lighting repair time met for the last 5 work orders? |
| Q-PER-003-03 | Q-PER-003-02 | Is every gate gap (hinges, between leaves, under) 2 in (5 cm) or less? |
| Q-RCV-001-03 | Q-RCV-001-01 | Are backups separated from production credentials? |
| Q-VSS-002-03 | Q-VSS-002-01 | Do camera views cover all parking areas with no blind spots? |

### Changed: split questions (text narrowed to the first check, guidance rewritten)

Q-ENV-005-02 (written repair time exists), Q-GOV-003-02 (register scores risks with a defined method), Q-GRD-006-01 (incident entries complete), Q-IDS-005-01 (panic buttons installed), Q-LGT-004-02 (repair time defined), Q-PER-003-02 (gates match fence height), Q-RCV-001-01 (offline or immutable copy), Q-VSS-002-01 (perimeter line coverage). Answers recorded against these ids under 1.0.0 covered both checks; assessments pinned to 1.0.0 keep the old wording.

### Changed: "Partial:" definition added to guidance (question text unchanged)

Q-ACC-003-03, Q-ACC-007-02, Q-CRY-005-02, Q-CRY-009-02, Q-CRY-010-02, Q-CRY-010-03, Q-ENV-002-01, Q-GOV-001-02, Q-GRD-006-02, Q-IDN-004-02, Q-IDN-006-02, Q-IDS-001-02, Q-IDS-002-01, Q-IDS-006-02, Q-LCK-002-03, Q-LCK-003-01, Q-LCK-003-02, Q-LGT-002-01, Q-LGT-005-02, Q-LGT-006-01, Q-PER-001-03, Q-PER-005-01, Q-PER-006-02, Q-POL-002-02, Q-POL-007-01, Q-PRT-004-02, Q-RSP-003-02, Q-RSP-005-02, Q-VSS-004-02, Q-VSS-006-02, Q-VSS-007-02.

### Changed: "(unverified)" notes rewritten as "Target to confirm:" (question text unchanged)

Q-CRY-004-02, Q-CRY-009-02, Q-ENV-002-01, Q-LGT-001-01, Q-PER-001-01, Q-PER-002-01, Q-PER-004-02, Q-PER-005-01, Q-VSS-001-02, Q-VSS-002-02. The source flags themselves remain in the README "Flagged and unverified items" table.

## 1.0.0 (2026-11-04)

Initial library: 101 shared controls, 176 questions, 5 frameworks, 272 crosswalk entries.
