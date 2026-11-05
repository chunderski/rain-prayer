/**
 * Glue between the database and the pure risk engine (@sentinel/risk). Gathers the scoring input for
 * an assessment, computes live results, and stores or reads frozen snapshots (D-058).
 */
import * as riskPkg from "@sentinel/risk";
import type { CompareInput, ScoreAssessmentInput, ScoringControl } from "@sentinel/risk";
import type { Answer, Finding, Question, RiskResult, SiteComparison, ThreatScenario } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { assessmentScope, type FieldCtx } from "../field/context.js";
import { listLive } from "../field/records.js";
import { AppError } from "../lib/errors.js";

export interface RiskEngine {
  METHOD_VERSION: string;
  scoreAssessment(i: ScoreAssessmentInput): RiskResult;
  compareSites(i: CompareInput[]): SiteComparison;
  loadScenarios(): ThreatScenario[];
  scenariosForControls(s: ThreatScenario[], controlIds: string[]): ThreatScenario[];
}

export interface RiskDeps {
  /** Defaults to @sentinel/risk. */
  engine?: RiskEngine;
  /** Scenario library override (tests use fixture scenarios that match the fixture control library). */
  scenarios?: ThreatScenario[];
}

export const riskUnavailable = (cause?: unknown) =>
  new AppError(503, "risk_unavailable", `Risk scoring is not available: ${cause instanceof Error ? cause.message : "engine error"}`);

export interface StoredInput {
  scenarioId: string;
  likelihood: number;
  impact: number;
  rationale: string | null;
  excluded: boolean;
}

export class RiskService {
  readonly engine: RiskEngine;
  private scenarios?: ThreatScenario[];

  constructor(deps: RiskDeps = {}) {
    this.engine = deps.engine ?? (riskPkg as unknown as RiskEngine);
    this.scenarios = deps.scenarios;
  }

  get methodVersion(): string {
    return this.engine.METHOD_VERSION;
  }

  library(): ThreatScenario[] {
    if (!this.scenarios) {
      try {
        this.scenarios = this.engine.loadScenarios();
      } catch (err) {
        throw riskUnavailable(err);
      }
    }
    return this.scenarios;
  }

  /** Scenarios relevant to the assessment's in-scope shared controls. */
  async relevant(ctx: FieldCtx, assessmentId: string): Promise<ThreatScenario[]> {
    const scope = await assessmentScope(ctx, assessmentId);
    try {
      return this.engine.scenariosForControls(this.library(), [...scope.controls.keys()]);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw riskUnavailable(err);
    }
  }

  async storedInputs(tx: Tx, assessmentId: string): Promise<StoredInput[]> {
    const { rows } = await tx.query<StoredInput>(
      `SELECT scenario_id AS "scenarioId", likelihood, impact, rationale, excluded FROM scenario_input
        WHERE assessment_id = $1 ORDER BY scenario_id`,
      [assessmentId],
    );
    return rows;
  }

  async scoringInput(ctx: FieldCtx, assessmentId: string, computedAt: string): Promise<ScoreAssessmentInput> {
    const scope = await assessmentScope(ctx, assessmentId);
    const scenarios = await this.relevant(ctx, assessmentId);
    const ids = [...scope.controls.keys()];
    const q = await ctx.tx.query<{
      c: string; id: string; text: string; answer_type: string; compliant_answer: string | null; options: unknown; scale: unknown;
      unit: string | null; guidance: string; photo_on_deficiency: boolean;
    }>(
      `SELECT shared_control_id AS c, id, text, answer_type, compliant_answer, options, scale, unit, guidance, photo_on_deficiency
         FROM question WHERE library_version = $1 AND shared_control_id = ANY($2::text[]) ORDER BY shared_control_id, sort_order`,
      [scope.libraryVersion, ids],
    );
    const byControl = new Map<string, Question[]>();
    for (const r of q.rows) {
      const question = {
        id: r.id, text: r.text, answerType: r.answer_type, guidance: r.guidance, photoOnDeficiency: r.photo_on_deficiency,
        ...(r.compliant_answer ? { compliantAnswer: r.compliant_answer } : {}),
        ...(r.options ? { options: r.options } : {}),
        ...(r.scale ? { scale: r.scale } : {}),
        ...(r.unit ? { unit: r.unit } : {}),
      } as unknown as Question;
      byControl.set(r.c, [...(byControl.get(r.c) ?? []), question]);
    }
    const controls: ScoringControl[] = [...scope.controls.values()].map((c) => ({ id: c.id, title: c.title, questions: byControl.get(c.id) ?? [] }));
    const relevantIds = new Set(scenarios.map((s) => s.id));
    const inputs = (await this.storedInputs(ctx.tx, assessmentId))
      .filter((i) => relevantIds.has(i.scenarioId))
      .map((i) => ({ scenarioId: i.scenarioId, likelihood: i.likelihood, impact: i.impact, excluded: i.excluded, ...(i.rationale ? { rationale: i.rationale } : {}) }));
    const answers = (await listLive(ctx, "answer", "assessment_id", assessmentId)) as unknown as Answer[];
    const findings = (await listLive(ctx, "finding", "assessment_id", assessmentId)) as unknown as Finding[];
    return { assessmentId, computedAt, scenarios, inputs, controls, answers, findings };
  }

  async computeLive(ctx: FieldCtx, assessmentId: string): Promise<RiskResult> {
    const input = await this.scoringInput(ctx, assessmentId, new Date().toISOString());
    try {
      return this.engine.scoreAssessment(input);
    } catch (err) {
      throw riskUnavailable(err);
    }
  }

  async latestSnapshot(tx: Tx, assessmentId: string): Promise<RiskResult | null> {
    const { rows } = await tx.query<{ result: RiskResult }>(
      "SELECT result FROM risk_snapshot WHERE assessment_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [assessmentId],
    );
    return rows[0]?.result ?? null;
  }

  /** Snapshot for complete assessments (frozen numbers), live otherwise. */
  async resultFor(ctx: FieldCtx, assessmentId: string): Promise<RiskResult> {
    const scope = await assessmentScope(ctx, assessmentId);
    if (scope.status === "complete") {
      const snap = await this.latestSnapshot(ctx.tx, assessmentId);
      if (snap) return snap;
    }
    return this.computeLive(ctx, assessmentId);
  }

  async snapshot(ctx: FieldCtx, assessmentId: string): Promise<RiskResult> {
    const result = await this.computeLive(ctx, assessmentId);
    await ctx.tx.query(
      `INSERT INTO risk_snapshot (tenant_id, assessment_id, method_version, result, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [ctx.auth.tenantId, assessmentId, result.methodVersion, JSON.stringify(result), ctx.auth.userId],
    );
    return result;
  }
}
