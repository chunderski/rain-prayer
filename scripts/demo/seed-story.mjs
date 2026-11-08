/**
 * Demo story: fills a fresh Sentinel Assess database with a believable customer walkthrough.
 * Talks to a running API over HTTP, as the seeded owner, so every row goes through the real rules.
 *
 *   Acme Integrators (the integrator, seeded by db:seed) works for Harbor Logistics:
 *   - North terminal: a full converged assessment, three findings with photos, risk scored,
 *     an approved executive summary, completed, and a Good / Better / Best quote sent to the client
 *   - South yard: the same site type in worse shape, still in progress (good for Compare)
 *   - Dana Ortiz, Harbor's client login, can see the finished report and accept the quote
 *
 * Demo content only. The answers and risk inputs are illustrative, not a real assessment.
 * Used by scripts/demo/run-demo.mjs; can also run alone: node scripts/demo/seed-story.mjs [apiBase]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
export const DEMO_PASSWORD = "Sentinel-dev-2026!";
export const CLIENT_LOGIN = { email: "dana@harbor.example", password: "Harbor-client-2026!", name: "Dana Ortiz" };

export async function seedStory(api, log = console.log) {
  const json = async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${new URL(res.url).pathname} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const login = async (email, password = DEMO_PASSWORD) =>
    (await json(await fetch(`${api}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }))).accessToken;
  const as = (token) => (method, path, body, rawType) =>
    fetch(api + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": rawType ?? "application/json" },
      body: rawType ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  const uuid = () => crypto.randomUUID();
  const now = () => new Date().toISOString();

  const owner = as(await login("owner@acme.test"));
  const assessor = as(await login("assessor@acme.test"));

  // Branding: the integrator's own look on reports and the client portal.
  await json(await owner("PUT", "/branding", {
    displayName: "Acme Integrators", primaryColor: "#0b4f6c", accentColor: "#c8553d",
    reportFooter: "Acme Integrators LLC, licensed security contractor.",
    contactEmail: "assessments@acme.example", contactPhone: "+1 303 555 0100", website: "https://acme.example", showPoweredBy: false,
  }));
  await json(await owner("PUT", "/branding/logo", readFileSync(join(ASSETS, "logo.png")), "image/png"));
  log("branding and logo set");

  const frameworks = await json(await owner("GET", "/frameworks"));
  const allFrameworks = ["physical-general", "cpted", "carver", "nist-csf-2", "pqc-readiness"];
  const picked = frameworks.filter((f) => allFrameworks.includes(f.id)).map((f) => ({ frameworkId: f.id, version: f.version }));
  const scenarios = await json(await owner("GET", "/risk/scenarios"));

  const harbor = await json(await owner("POST", "/clients", { name: "Harbor Logistics", industry: "Freight and warehousing" }));
  await json(await owner("POST", "/clients", { name: "Mesa County Schools", industry: "Education" }));

  const sites = [
    { name: "North terminal", address: "1200 Harbor Way", quality: 0.82 },
    { name: "South yard", address: "88 Dockside Rd", quality: 0.45 },
  ];
  const assessments = {};
  for (const st of sites) {
    const site = await json(await owner("POST", "/sites", { clientId: harbor.id, name: st.name, address: st.address, siteType: "Distribution center" }));
    const areas = {};
    const areaList = [["Perimeter and gates", "perimeter"], ["East parking", "parking"], ["Loading dock", "exterior"], ["Server room", "it_room"]];
    for (const [i, [name, kind]] of areaList.entries()) {
      const id = uuid();
      await json(await owner("POST", `/sites/${site.id}/areas`, { id, name, kind, sortOrder: i }));
      areas[kind] = id;
    }
    const a = await json(await owner("POST", "/assessments", { siteId: site.id, title: `${st.name} security assessment`, frameworks: picked }));

    // Answers: a fixed pattern so every run gives the same scores; North is in better shape than South.
    const walkthrough = await json(await owner("GET", `/assessments/${a.id}/walkthrough`));
    let i = 0;
    for (const section of walkthrough.sections) for (const control of section.controls) for (const q of control.questions) {
      if (!["yes_partial_no_na", "yes_no_na"].includes(q.answerType)) continue;
      i++;
      const r = ((i * 37) % 100) / 100;
      const value = r < st.quality ? "yes" : q.answerType === "yes_no_na" || r > 0.92 ? "no" : "partial";
      const id = uuid();
      await json(await owner("PUT", `/assessments/${a.id}/answers/${id}`, { id, assessmentId: a.id, questionId: q.id, areaId: null, value: { kind: "choice", value }, answeredAt: now() }));
    }

    const findings = [
      { title: "Perimeter fence fabric cut near the east gate post", description: "A cut about 18 in long in the chain link fabric, low enough to crawl through, hidden from the guard post by stacked pallets.", recommendation: "Repair the fabric, add a bottom tension wire, and move the pallet stack to restore the sightline from the guard post.", severity: "high", controlIds: ["SC-PER-001"], area: "perimeter", photo: "fence-cut", assetType: "fence" },
      { title: "East parking pole light out", description: "One of two pole lights in the east parking area does not work, leaving the north half of the lot dark after 6 pm.", recommendation: "Replace the lamp and add the pole to the monthly lighting check.", severity: "medium", controlIds: ["SC-LGT-001"], area: "parking", photo: "parking-dark", assetType: "lighting" },
      { title: "Rear dock door propped open with a wedge", description: "The door was wedged open during the visit with no staff in view; the door contact alarm was silenced.", recommendation: "Fit a held-open alarm, remove wedges, and brief dock staff.", severity: st.quality < 0.6 ? "critical" : "high", controlIds: ["SC-ACC-001"], area: "exterior", photo: "door-propped", assetType: "door" },
    ];
    for (const f of findings) {
      const fid = uuid();
      await json(await owner("PUT", `/assessments/${a.id}/findings/${fid}`, { id: fid, assessmentId: a.id, areaId: areas[f.area], title: f.title, description: f.description, recommendation: f.recommendation, severity: f.severity, status: "confirmed", controlIds: f.controlIds }));
      const bytes = readFileSync(join(ASSETS, `${f.photo}.jpg`));
      const pid = uuid();
      await json(await owner("POST", `/assessments/${a.id}/photos`, { id: pid, assessmentId: a.id, areaId: areas[f.area], findingId: fid, controlIds: f.controlIds, assetType: f.assetType, severity: f.severity, notes: f.title, capturedAt: now(), contentType: "image/jpeg", byteSize: bytes.length }));
      await json(await owner("PUT", `/photos/${pid}/content`, bytes, "image/jpeg"));
    }

    const lik = { theft: [3, 3], "forced-entry": [3, 4], vandalism: [3, 2], "active-threat": [1, 5], "insider-threat": [2, 4], "cyber-intrusion": [3, 4], "quantum-data-exposure": [2, 4], tailgating: [4, 3], ransomware: [3, 5] };
    await json(await owner("PUT", `/assessments/${a.id}/risk/inputs`, {
      scenarios: scenarios.map((s) => ({ scenarioId: s.id, likelihood: (lik[s.id] ?? [2, 3])[0], impact: (lik[s.id] ?? [2, 3])[1], excluded: false, rationale: "Based on site history, location, and client interview." })),
    }));
    const risk = await json(await owner("GET", `/assessments/${a.id}/risk`));
    assessments[st.name] = { id: a.id, risk };
    log(`${st.name}: answers, 3 findings with photos, risk ${risk.overall.level.replace("_", " ")}`);
  }

  // North terminal: approved summary, completed, quoted, and sent to the client.
  const north = assessments["North terminal"];
  const top = [...north.risk.scenarios].sort((x, y) => y.residual.score - x.residual.score).slice(0, 2);
  await json(await owner("PUT", `/assessments/${north.id}/narrative/executive_summary`, {
    approve: true,
    text: `Harbor Logistics asked for a combined physical and cyber security assessment of the North terminal. The assessor walked the perimeter, parking, loading dock, and server room, and reviewed policies and IT controls against general physical security practice, CPTED, CARVER, NIST CSF 2.0, and post-quantum cryptography readiness.

Overall residual risk is ${north.risk.overall.level.replace("_", " ")}. The highest remaining risks are ${top[0].name.toLowerCase()} and ${top[1].name.toLowerCase()}. Three findings need attention: a cut in the perimeter fence near the east gate, a failed pole light in the east parking area, and a rear dock door propped open with its alarm silenced.

All three can be fixed quickly and at modest cost. Repairing the fence and controlling the dock door would most reduce the risk of forced entry and theft.`,
  }));
  for (const status of ["in_progress", "in_review", "complete"]) await json(await owner("PATCH", `/assessments/${north.id}`, { status }));
  await json(await owner("PATCH", `/assessments/${assessments["South yard"].id}`, { status: "in_progress" }));
  log("North terminal: summary approved, assessment completed");

  let quote = await json(await owner("POST", `/assessments/${north.id}/quotes`, { title: "North terminal remediation", tiers: ["good", "better", "best"] }));
  const lines = quote.lines.map((l) => (l.needsPricing ? { ...l, needsPricing: false, materialCost: 250, laborHours: 2 } : l));
  quote = await json(await owner("PUT", `/quotes/${quote.id}`, { title: quote.title, laborRate: quote.laborRate, validUntil: quote.validUntil, tiers: quote.tiers, notes: "Prices valid for 30 days.", terms: quote.terms, lines }));
  quote = await json(await assessor("POST", `/quotes/${quote.id}/actions`, { action: "submit" }));
  if (quote.status === "pending_approval") quote = await json(await owner("POST", `/quotes/${quote.id}/actions`, { action: "approve" }));
  quote = await json(await owner("POST", `/quotes/${quote.id}/actions`, { action: "send" }));
  log(`quote ${quote.number} sent to the client (${quote.lines.length} lines)`);

  const invite = await json(await owner("POST", "/members", { email: CLIENT_LOGIN.email, name: CLIENT_LOGIN.name, role: "client_viewer", clientId: harbor.id }));
  const token = decodeURIComponent(new URL(invite.setupUrl).hash.replace("#token=", ""));
  await json(await fetch(`${api}/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: CLIENT_LOGIN.password }) }));
  log(`client login ready: ${CLIENT_LOGIN.email}`);
  return { northId: north.id, southId: assessments["South yard"].id, quoteId: quote.id };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  seedStory(process.argv[2] ?? "http://127.0.0.1:3000").catch((e) => {
    console.error("Demo story failed:", e.message);
    process.exit(1);
  });
}
