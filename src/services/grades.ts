import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { readList, readObject, id, str, num, rows, richText, object, mapLimit, type Row } from "./data.js";
import { hasReadLimits, readSource, recordLimit, type ReadState } from "../utils/read-status.js";

/** Class-statistics reads in flight at once, after the first probe. */
const STATISTICS_CONCURRENCY = 4;
/** Grade items probed per call; one read each. */
const MAX_STATISTICS_ITEMS = 100;

export interface GradeStatistics {
  gradeItemId: number;
  minimum: number | null; maximum: number | null; average: number | null; median: number | null;
  mode: number[]; standardDeviation: number | null;
}

const round = (n: number) => Math.round(n * 100) / 100;
function statValue(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v);
  if (n === null) throw new Error("Invalid grade statistic");
  return round(n);
}

/** Validate a GradeStatisticsInfo block; malformed responses become an "error" read, never fabricated values. */
function parseStatistics(value: unknown, gradeItemId: number): GradeStatistics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GradeStatisticsInfo");
  const r = value as Row;
  if (r.GradeObjectId !== undefined && id(r.GradeObjectId) !== gradeItemId) throw new Error("Statistics for a different grade item");
  if (r.Mode !== undefined && r.Mode !== null && !Array.isArray(r.Mode)) throw new Error("Invalid statistics mode");
  const mode = (Array.isArray(r.Mode) ? r.Mode : []).map(m => {
    const value = statValue(m);
    if (value === null) throw new Error("Invalid statistics mode");
    return value;
  });
  return { gradeItemId, minimum: statValue(r.Minimum), maximum: statValue(r.Maximum), average: statValue(r.Average),
    median: statValue(r.Median), mode, standardDeviation: statValue(r.StandardDeviation) };
}

/**
 * Class statistics per grade item. Brightspace only returns them when the instructor shares them: a 403
 * means "not shared with you", not missing data. The first item is probed alone and probing stops after
 * the first 403 in a course; remaining items are reported as not checked.
 */
export async function gradeStatistics(api: D2LApiClient, courseId: number, gradeItemIds: number[]) {
  const unique = [...new Set(gradeItemIds)];
  if (unique.length > MAX_STATISTICS_ITEMS) recordLimit(`Grade statistics checked for the first ${MAX_STATISTICS_ITEMS} items`);
  let denied = false;
  const probe = async (gradeItemId: number): Promise<{ gradeItemId: number; status: ReadState | "not_checked_after_denial"; data?: GradeStatistics }> => {
    if (denied) return { gradeItemId, status: "not_checked_after_denial" };
    const path = api.le(courseId, `/grades/${gradeItemId}/statistics`);
    const read = await readSource(path, async () =>
      parseStatistics(await api.get<unknown>(path, { ttl: DEFAULT_CACHE_TTLS.grades }), gradeItemId));
    if (read.status === "forbidden") denied = true;
    return read.data ? { gradeItemId, status: read.status, data: read.data } : { gradeItemId, status: read.status };
  };
  const [first, ...rest] = unique.slice(0, MAX_STATISTICS_ITEMS);
  const results = first === undefined ? [] : [await probe(first), ...await mapLimit(rest, STATISTICS_CONCURRENCY, probe)];
  const items = results.flatMap(r => r.data ? [r.data] : []);
  const unavailable = results.filter(r => !r.data && r.status !== "not_checked_after_denial").map(({ gradeItemId, status }) => ({ gradeItemId, status }));
  const notChecked = results.filter(r => r.status === "not_checked_after_denial").map(r => r.gradeItemId);
  const status = !results.length ? "no_items" : items.length === results.length ? "available" : items.length ? "partial" :
    denied ? "not_shared" : "unavailable";
  return { status, items, unavailable, notChecked,
    ...denied ? { note: "Brightspace denied class statistics (403): the instructor has not shared them with you. This is not missing data. Items after the first denial were not checked." } : {} };
}

export interface Scenario { gradeItemId: number; points: number }
/** Intentionally supports only fully described, uncategorized numeric points/weighted gradebooks. */
export function calculateScenario(setup: Row | null, objects: Row[], values: Row[], categories: Row[], exemptions: Row[] | null,
  scenarios: Scenario[], complete: boolean) {
  const reasons = new Set<string>();
  const system = str(setup?.GradingSystem);
  if (!complete) reasons.add("Required grade sources are unavailable or truncated.");
  if (system !== "Points" && system !== "Weighted") reasons.add("Only Points and Weighted grading systems are supported.");
  if (typeof setup?.IsNullGradeZero !== "boolean") reasons.add("The missing-grade rule is unknown.");
  if (categories.length || objects.some(o => id(o.CategoryId))) reasons.add("Category scaling, weighting and drop rules are not supported.");
  if (objects.some(o => o.CategoryId !== null && o.CategoryId !== 0 && !id(o.CategoryId))) reasons.add("Category membership is unknown.");
  if (new Set(objects.map(o => id(o.Id))).size !== objects.length) reasons.add("Duplicate grade object IDs.");
  if (new Set(values.map(v => id(v.GradeObjectIdentifier))).size !== values.length) reasons.add("Duplicate grade value IDs.");
  if (new Set((exemptions ?? []).map(e => id(e.GradeObjectId))).size !== exemptions?.length) reasons.add("Missing or duplicate personal exemption data.");
  if (!objects.length) reasons.add("No grade objects available.");
  const byId = new Map(values.map(v => [id(v.GradeObjectIdentifier), v]));
  const exemptionData = new Map((exemptions ?? []).map(e => [id(e.GradeObjectId), e]));
  const exemptById = new Map((exemptions ?? []).map(e => [id(e.GradeObjectId), e.IsExempt]));
  const overrides = new Map<number, number>();
  for (const scenario of scenarios) {
    if (overrides.has(scenario.gradeItemId)) reasons.add("Duplicate scenario item IDs.");
    overrides.set(scenario.gradeItemId, scenario.points);
    const o = objects.find(o => id(o.Id) === scenario.gradeItemId);
    if (!o || o.GradeType !== "Numeric" || o.IsHidden !== false || o.ExcludeFromFinalGradeCalculation !== false || exemptById.get(scenario.gradeItemId) !== false)
      reasons.add(`Scenario item ${scenario.gradeItemId} is not a verified visible, included, non-exempt grade item.`);
  }
  const contributions = [];
  let numerator = 0, denominator = 0, configuredWeight = 0;
  for (const o of objects) {
    const itemId = id(o.Id);
    if (o.GradeType === "Text") continue;
    if (o.ExcludeFromFinalGradeCalculation === true) continue;
    if (o.GradeType !== "Numeric" || o.IsBonus !== false || o.CanExceedMaxPoints !== false || o.IsHidden !== false || o.ExcludeFromFinalGradeCalculation !== false)
      reasons.add("Every included item must have verified numeric, visible, non-bonus rules without extra credit.");
    if (typeof exemptById.get(itemId) !== "boolean") reasons.add("Personal exemption status is unknown for one or more items.");
    if (exemptById.get(itemId) === true) continue;
    const max = num(o.MaxPoints), weight = num(o.Weight), value = byId.get(itemId);
    if (!itemId || max === null || max <= 0) { reasons.add("Invalid grade item ID or maximum points."); continue; }
    if (system === "Weighted" && (weight === null || weight < 0)) reasons.add("One or more grade weights are unknown or invalid.");
    configuredWeight += weight ?? 0;
    const entered = overrides.get(itemId), earned = entered ?? num(value?.PointsNumerator);
    if (entered === undefined && earned !== null && num(value?.PointsDenominator) !== max) reasons.add("A published score denominator disagrees with its grade object.");
    if (earned !== null && (earned < 0 || earned > max)) reasons.add(`Score outside supported range for item ${itemId}.`);
    // Absence from the visible-values route can mean an unreleased score, not an ungraded item.
    // Only apply the null-grade rule when the own-user exemption response confirms a null numeric value.
    if (earned === null && object(exemptionData.get(itemId)?.GradeValue).PointsNumerator !== null)
      reasons.add(`Cannot distinguish an ungraded item from an unreleased score for item ${itemId}; provide a scenario score.`);
    const points = earned ?? (setup?.IsNullGradeZero === true ? 0 : null);
    const unit = system === "Weighted" ? weight ?? 0 : max;
    const contribution = points === null ? null : points / max * unit;
    if (contribution !== null) { numerator += contribution; denominator += unit; }
    contributions.push({ gradeItemId: itemId, name: str(o.Name), points, maxPoints: max, weight,
      basis: entered !== undefined ? "scenario" : earned !== null ? "published" : points === null ? "omitted_ungraded" : "missing_as_zero", contribution });
  }
  if (system === "Weighted" && Math.abs(configuredWeight - 100) > 0.0001)
    reasons.add("Included weights must total 100; exemption renormalization is not supported.");
  if (!denominator) reasons.add("No numeric contribution can be calculated.");
  if (reasons.size) return { status: "unsupported", reasons: [...reasons], percentage: null };
  return { status: "calculated", system, percentage: numerator / denominator * 100, numerator, denominator, contributions,
    scope: "Projection using the returned grade objects and verified personal exemptions. Hidden or unreleased items omitted by Brightspace cannot be inferred. This is not an official final grade." };
}
export async function gradeSummary(api: D2LApiClient, courseId: number, scenarios: Scenario[], options: { includeStatistics?: boolean } = {}) {
  const [values, objects, categories, setup, final, user] = await Promise.all([
    readList(api, api.le(courseId, "/grades/values/myGradeValues/")), readList(api, api.le(courseId, "/grades/")),
    readList(api, api.le(courseId, "/grades/categories/")), readObject(api, api.le(courseId, "/grades/setup/")),
    readObject(api, api.le(courseId, "/grades/final/values/myGradeValue")), readObject(api, api.lp("/users/whoami")),
  ]);
  const userId = id(user.data?.Identifier);
  // Text items carry no numeric class statistics.
  const statisticIds = (objects.data ?? []).filter(o => o.GradeType !== "Text").map(o => id(o.Id)).filter((i): i is number => i !== null);
  // Snapshot before the optional statistics fan-out: its limits must not block grade projections.
  const gradeSourcesLimited = hasReadLimits();
  const [exemptions, statistics] = await Promise.all([
    userId ? readObject(api, api.le(courseId, `/grades/exemptions/${userId}`)) : null,
    options.includeStatistics ? gradeStatistics(api, courseId, statisticIds) : null,
  ]);
  const mappedValues = (values.data ?? []).map(v => ({ id: id(v.GradeObjectIdentifier), name: str(v.GradeObjectName),
    displayGrade: str(v.DisplayedGrade), points: num(v.PointsNumerator), maxPoints: num(v.PointsDenominator),
    weightedPoints: num(v.WeightedNumerator), weight: num(v.WeightedDenominator), comments: richText(v.Comments),
    releasedDate: str(v.ReleasedDate), lastModified: str(v.LastModified) }));
  const exemptionRows = exemptions?.status === "available" && Array.isArray(exemptions.data?.Items) ? rows(exemptions.data.Items) : null;
  const sources = { values: values.status, objects: objects.status, categories: categories.status, setup: setup.status,
    final: final.status, exemptions: exemptions?.status ?? "unavailable" };
  const complete = [values, objects, categories].every(r => r.complete) && setup.status === "available" && exemptionRows !== null && !gradeSourcesLimited;
  return { courseId, sources, grades: mappedValues, setup: setup.data ? {
    gradingSystem: str(setup.data.GradingSystem), missingGradesAsZero: setup.data.IsNullGradeZero ?? null } : null,
    objects: (objects.data ?? []).map(o => ({ id: id(o.Id), name: str(o.Name), type: str(o.GradeType), description: richText(o.Description),
      categoryId: id(o.CategoryId), maxPoints: num(o.MaxPoints), weight: num(o.Weight), isHidden: o.IsHidden ?? null,
      isBonus: o.IsBonus ?? null, excluded: o.ExcludeFromFinalGradeCalculation ?? null, canExceed: o.CanExceedMaxPoints ?? null,
      associatedTool: o.AssociatedTool ?? null })),
    categories: (categories.data ?? []).map(c => ({ id: id(c.Id), name: str(c.Name), weight: num(c.Weight), maxPoints: num(c.MaxPoints),
      excluded: c.ExcludeFromFinalGrade ?? null, dropHighest: num(c.NumberOfHighestToDrop), dropLowest: num(c.NumberOfLowestToDrop),
      weightDistributionType: num(c.WeightDistributionType) })),
    officialFinal: final.data ? { displayGrade: str(final.data.DisplayedGrade), points: num(final.data.PointsNumerator), maxPoints: num(final.data.PointsDenominator) } : null,
    calculation: calculateScenario(setup.data, objects.data ?? [], values.data ?? [], categories.data ?? [], exemptionRows, scenarios, complete),
    ...statistics ? { statistics } : {} };
}
