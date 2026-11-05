/**
 * Test-only threat scenarios that mitigate the fixture controls (SC-PER-001, SC-PER-002), so the real
 * @sentinel/risk engine can score fixture assessments. Not product content.
 */
import { ThreatScenario } from "@sentinel/shared";

export const FIXTURE_SCENARIOS: ThreatScenario[] = [
  ThreatScenario.parse({
    id: "fixture-intrusion",
    name: "Fixture intrusion",
    description: "Test scenario: someone crosses the fixture perimeter.",
    category: "physical",
    mitigations: [{ controlId: "SC-PER-001", weight: 3 }],
    domains: ["PER"],
  }),
  ThreatScenario.parse({
    id: "fixture-crypto",
    name: "Fixture crypto exposure",
    description: "Test scenario: fixture cryptographic assets are unknown.",
    category: "cyber",
    mitigations: [{ controlId: "SC-PER-002", weight: 2 }, { controlId: "SC-PER-001", weight: 1 }],
    domains: ["PER"],
  }),
  ThreatScenario.parse({
    id: "fixture-unrelated",
    name: "Fixture unrelated",
    description: "Test scenario mitigated only by a control outside the fixture library.",
    category: "physical",
    mitigations: [{ controlId: "SC-ZZZ-001", weight: 1 }],
    domains: ["GRD"],
  }),
];
