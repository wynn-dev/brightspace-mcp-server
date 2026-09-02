import { describe, it, expect } from "vitest";
import { fetchEnrolledCourses, settleAcrossCourses } from "../../src/tools/course-helpers.js";
import { ApiError } from "../../src/api/index.js";
import { fakeApiClient, makeConfig, enrollment, enrollmentsPage } from "./helpers.js";

const COURSES = [
  enrollment(1, "Alpha", { role: "Instructor" }),
  enrollment(2, "Beta", { isActive: false }),
  enrollment(3, "Gamma"),
];

describe("fetchEnrolledCourses", () => {
  it("maps enrollments to courses and requests active-only by default", async () => {
    const apiClient = fakeApiClient({ "/enrollments/myenrollments/": enrollmentsPage(COURSES) });

    const courses = await fetchEnrolledCourses(apiClient as any, makeConfig());

    expect(apiClient.requested[0]).toContain("orgUnitTypeId=3&isActive=true");
    expect(courses).toEqual([
      { id: 1, name: "Alpha", code: "CODE-1", role: "Instructor", isActive: true, lastAccessed: null },
      { id: 3, name: "Gamma", code: "CODE-3", role: "Regular Student", isActive: true, lastAccessed: null },
    ]);
  });

  it("omits isActive=true and keeps inactive courses when activeOnly is false", async () => {
    const apiClient = fakeApiClient({ "/enrollments/myenrollments/": enrollmentsPage(COURSES) });

    const courses = await fetchEnrolledCourses(apiClient as any, makeConfig(), { activeOnly: false });

    expect(apiClient.requested[0]).not.toContain("isActive=true");
    expect(courses.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("applies include/exclude course filters from config", async () => {
    const apiClient = fakeApiClient({ "/enrollments/myenrollments/": enrollmentsPage(COURSES) });
    const config = makeConfig({ courseFilter: { activeOnly: true, excludeCourseIds: [3] } });

    const courses = await fetchEnrolledCourses(apiClient as any, config);

    expect(courses.map((c) => c.id)).toEqual([1]);
  });
});

describe("settleAcrossCourses", () => {
  const courses = [
    { id: 1, name: "A", code: "A", role: "r", isActive: true, lastAccessed: null },
    { id: 2, name: "B", code: "B", role: "r", isActive: true, lastAccessed: null },
    { id: 3, name: "C", code: "C", role: "r", isActive: true, lastAccessed: null },
  ];

  it("returns fulfilled values in course order and drops 403s and other failures", async () => {
    const values = await settleAcrossCourses(courses, "demo", async (course) => {
      if (course.id === 2) throw new ApiError(403, "/x", "forbidden");
      if (course.id === 3) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      return course.id * 10;
    });

    expect(values).toEqual([10]);
  });

  it("preserves order even when later courses resolve first", async () => {
    const values = await settleAcrossCourses(courses, "demo", async (course) => {
      await new Promise((r) => setTimeout(r, (4 - course.id) * 5));
      return course.name;
    });

    expect(values).toEqual(["A", "B", "C"]);
  });
});
