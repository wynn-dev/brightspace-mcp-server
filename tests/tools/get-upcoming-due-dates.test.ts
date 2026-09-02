import { describe, it, expect } from "vitest";
import { registerGetUpcomingDueDates } from "../../src/tools/get-upcoming-due-dates.js";
import { captureTool, fakeApiClient, parse, enrollment, enrollmentsPage, objectPage } from "./helpers.js";

const event = (id: string, endDate: string, orgUnitId = 1) => ({
  CalendarEventId: id,
  Title: `Event ${id}`,
  OrgUnitName: "Course",
  OrgUnitId: orgUnitId,
  StartDateTime: endDate,
  EndDateTime: endDate,
  IsAllDayEvent: false,
});

describe("get_upcoming_due_dates", () => {
  it("defaults to a 7-day window and queries the enrolled courses' ids", async () => {
    const apiClient = fakeApiClient({
      "/enrollments/myenrollments/": enrollmentsPage([enrollment(11, "A"), enrollment(22, "B")]),
      "/calendar/events/myEvents/": objectPage([]),
    });
    const { call } = captureTool(registerGetUpcomingDueDates, apiClient);

    const before = Date.now();
    await call({});

    const eventsPath = apiClient.requested[1];
    expect(eventsPath).toContain("orgUnitIdsCSV=11,22");
    const params = new URL(`https://x${eventsPath}`).searchParams;
    const windowMs =
      new Date(params.get("endDateTime")!).getTime() - new Date(params.get("startDateTime")!).getTime();
    expect(windowMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(new Date(params.get("startDateTime")!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("skips the enrollment lookup when a courseId is given", async () => {
    const apiClient = fakeApiClient({ "/calendar/events/myEvents/": objectPage([]) });
    const { call } = captureTool(registerGetUpcomingDueDates, apiClient);

    await call({ courseId: 5, daysAhead: 3 });

    expect(apiClient.requested).toHaveLength(1);
    expect(apiClient.requested[0]).toContain("orgUnitIdsCSV=5");
  });

  it("maps events and sorts them soonest-first", async () => {
    const apiClient = fakeApiClient({
      "/calendar/events/myEvents/": objectPage([
        event("late", "2026-09-10T00:00:00Z"),
        event("soon", "2026-09-03T00:00:00Z"),
      ]),
    });
    const { call } = captureTool(registerGetUpcomingDueDates, apiClient);

    const result = parse(await call({ courseId: 1 }));

    expect(result.map((e: { id: string }) => e.id)).toEqual(["soon", "late"]);
    expect(result[0]).toEqual({
      id: "soon",
      title: "Event soon",
      courseName: "Course",
      courseId: 1,
      startDate: "2026-09-03T00:00:00Z",
      endDate: "2026-09-03T00:00:00Z",
      isAllDay: false,
    });
  });
});
