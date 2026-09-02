import { describe, it, expect } from "vitest";
import { registerGetMyGrades } from "../../src/tools/get-my-grades.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, enrollment, enrollmentsPage } from "./helpers.js";

const gradeValue = (name: string, comment?: string) => ({
  GradeObjectIdentifier: "1",
  GradeObjectName: name,
  DisplayedGrade: "90 %",
  PointsNumerator: 9,
  PointsDenominator: 10,
  WeightedNumerator: null,
  WeightedDenominator: null,
  Comments: comment ? { Text: comment, Html: `<p>${comment}</p>` } : null,
  PrivateComments: null,
  LastModified: "2026-09-01T00:00:00Z",
  ReleasedDate: null,
});

describe("get_my_grades", () => {
  it("returns mapped grades for a single course", async () => {
    const apiClient = fakeApiClient({
      "/7/grades/values/myGradeValues/": [gradeValue("Quiz 1", "Nice"), gradeValue("Lab 1")],
    });
    const { call } = captureTool(registerGetMyGrades, apiClient);

    const result = parse(await call({ courseId: 7 }));

    expect(result.courseId).toBe(7);
    expect(result.grades).toEqual([
      {
        name: "Quiz 1",
        displayGrade: "90 %",
        pointsNumerator: 9,
        pointsDenominator: 10,
        weightedNumerator: null,
        weightedDenominator: null,
        comments: "Nice",
        lastModified: "2026-09-01T00:00:00Z",
      },
      expect.objectContaining({ name: "Lab 1", comments: null }),
    ]);
    expect(apiClient.requested).toEqual(["/d2l/api/le/1.0/7/grades/values/myGradeValues/"]);
  });

  it("fans out across enrolled courses and skips ones that return 403", async () => {
    const apiClient = fakeApiClient({
      "/enrollments/myenrollments/": enrollmentsPage([enrollment(1, "Alpha"), enrollment(2, "Beta")]),
      "/1/grades/values/myGradeValues/": [gradeValue("Exam")],
      "/2/grades/values/myGradeValues/": () => {
        throw new ApiError(403, "/x", "forbidden");
      },
    });
    const { call } = captureTool(registerGetMyGrades, apiClient);

    const result = parse(await call({}));

    expect(result).toEqual({
      courses: [{ courseId: 1, courseName: "Alpha", grades: [expect.objectContaining({ name: "Exam" })] }],
    });
  });
});
