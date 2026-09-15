import { describe, it, expect } from "vitest";
import { calculateScenario } from "../../src/services/grades.js";
import { registerGetGradeSummary } from "../../src/tools/get-grade-summary.js";
import { captureTool, fakeApiClient, parse } from "../tools/helpers.js";
const item = (Id: number, MaxPoints: number, Weight = 50) => ({ Id, Name: `Item ${Id}`, MaxPoints, Weight, CategoryId: 0, GradeType: "Numeric", IsBonus: false, IsHidden: false, CanExceedMaxPoints: false, ExcludeFromFinalGradeCalculation: false });
const objects = [item(1, 10, 40), item(2, 20, 60)];
const values = [{ GradeObjectIdentifier: "1", PointsNumerator: 8, PointsDenominator: 10 }];
const exemptions = [{ GradeObjectId: 1, IsExempt: false, GradeValue: { PointsNumerator: null } }, { GradeObjectId: 2, IsExempt: false, GradeValue: { PointsNumerator: null } }];
const setup = { GradingSystem: "Points", IsNullGradeZero: false };
describe("verified grade projections", () => {
  it("computes points and shows individual contributions without mutating values", () => {
    const r = calculateScenario(setup, objects, values, [], exemptions, [{ gradeItemId: 2, points: 10 }], true);
    expect(r).toMatchObject({ status: "calculated", percentage: 60, numerator: 18, denominator: 30 });
    expect(values).toHaveLength(1);
  });
  it("applies verified missing-grade rules and preserves a real zero", () => {
    expect(calculateScenario(setup, objects, values, [], exemptions, [], true).percentage).toBe(80);
    expect(calculateScenario({ ...setup, IsNullGradeZero: true }, objects, values, [], exemptions, [], true).percentage).toBeCloseTo(26.6666667);
    expect(calculateScenario(setup, objects, values, [], exemptions, [{ gradeItemId: 2, points: 0 }], true).percentage).toBeCloseTo(26.6666667);
  });
  it("does not treat an unreleased or unverifiable score as an ungraded zero", () => {
    const uncertain = [{ GradeObjectId: 1, IsExempt: false }, { GradeObjectId: 2, IsExempt: false }];
    expect(calculateScenario({ ...setup, IsNullGradeZero: true }, objects, values, [], uncertain, [], true).status).toBe("unsupported");
    expect(calculateScenario(setup, objects, values, [], uncertain, [{ gradeItemId: 2, points: 10 }], true).percentage).toBe(60);
  });
  it("computes verified uncategorized weighted results", () => {
    const r = calculateScenario({ ...setup, GradingSystem: "Weighted" }, objects, values, [], exemptions, [{ gradeItemId: 2, points: 10 }], true);
    expect(r).toMatchObject({ status: "calculated", percentage: 62 });
  });
  it.each([
    ["formula", { setup: { ...setup, GradingSystem: "Formula" } }],
    ["category drop", { categories: [{ Id: 5, NumberOfLowestToDrop: 1 }] }],
    ["bonus", { objects: [{ ...objects[0], IsBonus: true }, objects[1]] }],
    ["hidden item", { objects: [{ ...objects[0], IsHidden: true }, objects[1]] }],
    ["unknown exemptions", { exemptions: null }],
    ["truncated data", { complete: false }],
    ["invalid weight sum", { setup: { ...setup, GradingSystem: "Weighted" }, objects: [item(1, 10, 10), item(2, 20, 10)] }],
    ["unknown scenario item", { scenarios: [{ gradeItemId: 77, points: 1 }] }],
    ["extra credit scenario", { scenarios: [{ gradeItemId: 2, points: 30 }] }],
    ["duplicate scenario", { scenarios: [{ gradeItemId: 2, points: 1 }, { gradeItemId: 2, points: 2 }] }],
  ])("refuses %s", (_name, options) => {
    const o = { setup, objects, values, categories: [], exemptions, scenarios: [], complete: true, ...options };
    const r = calculateScenario(o.setup, o.objects, o.values, o.categories, o.exemptions, o.scenarios, o.complete);
    expect(r.status).toBe("unsupported"); expect(r.percentage).toBeNull();
  });
  it("keeps official final separate and never exposes private comments or bulk scores", async () => {
    const api = fakeApiClient({ "/grades/": objects, "/grades/categories/": [], "/grades/setup/": setup, "/users/whoami": { Identifier: "42" },
      "/grades/values/myGradeValues/": [{ ...values[0], PrivateComments: { Text: "secret" }, Comments: { Text: "public" } }],
      "/grades/exemptions/42": { Items: exemptions.map(e => ({ ...e, GradeValue: { DisplayValue: "UNRELEASED_SECRET_SCORE" } })) },
      "/grades/final/values/myGradeValue": { DisplayedGrade: "B", PointsNumerator: 75, PointsDenominator: 100, PrivateComments: { Text: "secret" } } });
    const r = parse(await captureTool(registerGetGradeSummary, api).call({ courseId: 1, scenarios: [{ gradeItemId: 2, points: 10 }] }));
    expect(r.calculation.percentage).toBe(60); expect(r.officialFinal.displayGrade).toBe("B");
    expect(JSON.stringify(r)).not.toMatch(/secret|UNRELEASED_SECRET_SCORE/);
  });
});
