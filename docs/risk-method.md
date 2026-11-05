# Sentinel Assess risk method

Method version: `risk-method@1.0.0` (engine: `packages/risk`, scenario library: `packages/risk/data/scenarios.json` version 1.0.0, checked against control library 1.1.0).

This document explains how Sentinel Assess turns what an assessor saw on site into inherent, control, and residual risk scores. It is written so an assessor can explain and defend every number to a client. Every score in a report shows its inputs, the formula, and the controls and findings that drove it.

## 1. Approach in one paragraph

For each threat scenario that applies to the site, the assessor rates how likely it is and how bad it would be. Multiplying the two gives **inherent risk**: the risk if no security controls existed. The checklist answers and findings for the controls that counter that scenario give a **control effectiveness** between 0% and 100%. **Residual risk** is inherent risk reduced by control effectiveness, with controls credited for removing at most 80% of the risk. The approach of rating likelihood and impact on five-level scales and combining them follows the semi-quantitative method in NIST SP 800-30 Rev. 1, Guide for Conducting Risk Assessments (September 2012), Appendices G, H, and I. The bands, weights, and caps below are Sentinel choices, documented here, not values taken from that publication.

## 2. Threat scenarios

A scenario is a specific way harm could happen. The starter library has ten: theft of property or equipment, forced entry, vandalism and malicious damage, active threat (armed assailant), insider threat, cyber intrusion, ransomware, quantum-era data exposure (harvest now, decrypt later), unauthorized entry by tailgating, and physical tampering with IT equipment. Each scenario lists:

- the shared controls that mitigate it, each with a **relevance weight**: 3 primary (the control directly prevents or stops the scenario), 2 significant, 1 supporting. Weights are Sentinel analyst judgement and are listed in the scenario file so they can be reviewed;
- the security domains it relates to (used only as a fallback, see 4.3);
- public references the description and control choice draw on (for example CISA's Insider Threat Mitigation Guide, the CISA, NSA, and NIST Quantum-Readiness factsheet, NIST FIPS 203, 204, and 205).

The assessor can mark a scenario **not applicable** to the site (excluded). Excluded scenarios are not scored and do not count toward the overall result.

## 3. Inherent risk

**Inherent risk = likelihood x impact**, a whole number from 1 to 25. The assessor's rationale is stored with the ratings.

### Likelihood (1 to 5)

| Score | Label | Anchor |
|---|---|---|
| 1 | Rare | Not expected in the next 5 years. No history at this site, nearby, or at comparable sites, and no specific intent known. |
| 2 | Unlikely | Could happen within 5 years. Isolated history in the area or sector, little known intent toward this site. |
| 3 | Possible | Could happen within 1 to 3 years. Has happened at comparable sites or nearby, or the site is a plausible target. |
| 4 | Likely | Expected within the next year. Has happened at this site or close by recently, or there are known threats. |
| 5 | Almost certain | Expected several times a year or already happening. Recurring incidents or active, specific threats. |

Likelihood is rated for the threat against this site **as if the controls being assessed were absent**, so controls are not counted twice. Useful inputs: the site's incident history, local crime data, sector threat reporting, and how attractive the site's assets are.

### Impact (1 to 5)

| Score | Label | Anchor |
|---|---|---|
| 1 | Negligible | No injury. Loss absorbed in the normal operating budget. Disruption of a few hours at most. No sensitive data involved. |
| 2 | Minor | First aid injury. Loss noticeable but within a department's budget. Disruption under 1 day. Internal data exposed, no notification duty. |
| 3 | Moderate | Injury needing medical treatment. Loss needing management approval. Disruption of 1 to 3 days. Limited sensitive data exposed; local attention. |
| 4 | Major | Serious injury. Significant financial loss. Disruption up to 2 weeks. Regulated data breach requiring notification; regional attention. |
| 5 | Severe | Loss of life. Loss threatening the organization's viability. Prolonged shutdown. Large regulated breach; national attention or regulatory action. |

Use the highest row that any single consequence reaches (safety, money, operations, data, reputation). Money anchors are relative to the client's size on purpose; agree what "significant" means with the client at kickoff.

### Risk levels

The same bands apply to inherent and residual scores (residual scores can be fractional).

| Level | Score |
|---|---|
| Very low | below 4 |
| Low | 4 to below 7 |
| Medium | 7 to below 13 |
| High | 13 to below 20 |
| Very high | 20 and above |

On the 5 x 5 grid this puts 1 to 3 at very low, 4 to 6 at low, 8 to 12 at medium, 15 and 16 at high, and 20 and 25 at very high.

## 4. Control effectiveness

### 4.1 One control

Each shared control has objective questions. Answers are scored from 0 to 1:

| Answer | Score |
|---|---|
| Yes (or the compliant answer, when a question is phrased so that "No" is good) | 1 |
| Partial | 0.5 |
| No (the non-compliant answer) | 0 |
| N/A | excluded: neither helps nor hurts |
| Scale (for example 0 to 3) | normalized: (answer minus lowest) divided by (highest minus lowest) |
| Select | the library's score for the chosen option; the average when several are chosen; unscored if the options have no scores |
| Number (measurements such as fence height, percentages, counts) and free text | not scored |

**Why numbers are not scored:** the library does not yet record a target or which direction is better for each measurement (more lux is better; more unpatched systems is worse), and several targets are marked "Target to confirm". Scoring them now would mean inventing thresholds. Measurements still appear in the report as evidence and assessors should raise a finding when a measurement shows a weakness; the finding then lowers the score (4.2).

When a question is answered in several areas (for example the main gate and the loading dock), the area scores are **averaged per question**, and the control's answer score is the **average of its questions**. This way a question answered in ten areas does not outweigh one answered once.

### 4.2 Findings cap a control

An open finding against a control limits how effective that control can be, whatever the checklist says:

| Most severe open finding | Highest possible effectiveness |
|---|---|
| Critical | 0% |
| High | 25% |
| Medium | 50% |
| Low | 75% |
| Info | no cap |

Control effectiveness = the lower of the answer score and the cap. Draft and confirmed findings count; resolved findings are ignored. A finding mapped to several controls caps each of them. The reasoning: a finding is direct, specific evidence of a weakness, so it outranks a general checklist answer. A gate that "is controlled" but has cut fence fabric beside it is not 100% effective.

### 4.3 Unknown is not zero

If a control has no scored answers, its effectiveness is **unknown**, not zero. Unknown controls are left out of the average and reduce **coverage** (below), which lowers confidence. The one exception: when a control has no scored answers but has an open finding of low severity or higher, the finding is the evidence and the control takes the finding's cap (for example 25% for a high finding).

### 4.4 One scenario

Only controls **in scope** (in the frameworks chosen for this assessment) count. Scenario control effectiveness is the **weighted average** of the in-scope mitigating controls that have evidence, using the relevance weights:

effectiveness = sum of (weight x control effectiveness) / sum of weights, over controls with evidence.

**Coverage** is the share of in-scope relevance weight that has evidence. If none of a scenario's listed mitigating controls are in scope, in-scope controls from the scenario's domains stand in at weight 1, and confidence is capped at medium. If there is nothing at all, no reduction is credited and the report says so.

## 5. Residual risk

**Residual risk = inherent risk x (1 - effectiveness x 0.8)**

**Why 80 percent.** Controls reduce risk; they never remove it. Doors are propped, alarms are bypassed, people make mistakes, and an assessment is a point-in-time sample. Capping the credit at 80% means a site where every relevant control is fully effective still keeps one fifth of its inherent risk, so a very high inherent risk (25) cannot drop below 5 (low). This is a deliberate, conservative modelling choice by Sentinel, not a published constant; it is applied the same way to every scenario and site, so comparisons stay fair.

With no evidence, effectiveness counts as 0 and residual equals inherent: the method never gives credit for controls nobody checked.

### Confidence

| Confidence | Rule |
|---|---|
| High | evidence covers at least 80% of the in-scope relevance weight, and the selected frameworks include at least half of the scenario's total relevance weight |
| Medium | evidence covers at least 50% of the in-scope relevance weight (and not high) |
| Low | otherwise, including no evidence at all |

## 6. Overall site risk

- **Overall level** = the highest residual level of any scenario. A site is as exposed as its worst scenario, and averaging would hide it.
- **Overall inherent and residual numbers** = averages weighted by each scenario's inherent score, so serious scenarios count more than trivial ones. These are for trends and portfolio ranking; the level is what the client should act on.
- The overall explanation states how many scenarios were scored, awaiting inputs, or excluded, names the worst scenario, and lists scenarios with low confidence.

## 7. Explanations

Each scenario comes with three to six plain-English sentences, generated from the numbers above: the inherent rating; the overall effectiveness and coverage, naming controls not yet assessed and how many mitigating controls fall outside the selected frameworks; up to three contributing controls, ordered by how much they hold residual risk up (relevance weight x shortfall from 100%), each with the evidence and its most serious open finding; and the residual calculation with the confidence reason. Example:

> Perimeter fence height and condition (a significant control) is rated weak at 25% because 1 of 2 scored checks was fully met and 1 partly met, and a high finding is open, which limits the rating to 25%: Fence fabric cut near gate post.

## 8. Worked example

A depot assessed with a mix of physical and cyber controls. Scenario: theft. The assessor rates likelihood 4 (Likely: two yard thefts this year) and impact 3 (Moderate). **Inherent = 4 x 3 = 12, medium.**

| Control | Weight | Evidence | Effectiveness |
|---|---|---|---|
| Controlled entry points | 3 | lobby Yes (1), gate Partial (0.5): average 0.75 | 0.75 |
| Alarm monitoring and response | 3 | Yes | 1.00 |
| Perimeter fence height and condition | 2 | Partial and Yes: 0.75; open high finding "Fence fabric cut near gate post" caps at 0.25 | 0.25 |
| Perimeter gate control | 2 | Yes and No: 0.5; same high finding caps at 0.25 | 0.25 |
| Exterior opening detection | 2 | Yes; one N/A excluded | 1.00 |
| Entrance identification coverage | 2 | Partial | 0.50 |

Effectiveness = (3 x 0.75 + 3 x 1 + 2 x 0.25 + 2 x 0.25 + 2 x 1 + 2 x 0.5) / 14 = 9.25 / 14 = **66%**.
Residual = 12 x (1 - 0.661 x 0.8) = **5.7, low**. All six in-scope controls have evidence (coverage 100%) and the in-scope controls carry half of theft's total relevance weight, so confidence is **high**. Fixing the fence would lift both perimeter controls to their answer scores (0.75 and 0.5), raising effectiveness to 77% and lowering residual to 4.6. This example is the golden test in `packages/risk/src/__golden__/small-site.json`.

## 9. Comparing sites

Site comparison shows each site's overall result, residual by scenario, and open findings by severity. It adds caveats when the comparison is not like for like: different scoring method versions, different control library versions, different framework selections (fewer frameworks means fewer controls counted), scenarios scored at only some sites, assessments not yet complete (live scores), and low-confidence scenarios. Completed assessments use the scores frozen at completion.

## 10. Limitations an assessor should state

1. Likelihood and impact are expert judgements on anchored scales, not statistical probabilities. Two assessors can differ by one step; the rationale field should record why.
2. Relevance weights, finding caps, level bands, and the 80% ceiling are Sentinel modelling choices, applied consistently but not taken from a standard.
3. Measurements and free-text answers are not scored yet (see 4.1). Controls whose questions are all measurements (for example endpoint detection coverage, post staffing hours) contribute only through findings until the library records targets.
4. Effectiveness reflects the controls in the selected frameworks only. A scenario can look well controlled because the relevant weak controls were out of scope; the explanation states how many mitigating controls were out of scope.
5. Controls are treated as independent and additive. Real defenses work in layers, and one failure can make others irrelevant (an unmonitored alarm). Findings are the way to capture such dependencies.
6. Scores are a snapshot at the time of the assessment.
7. The scenario library and its references have not been reviewed by an external subject matter expert; treat weights as reviewable defaults.
