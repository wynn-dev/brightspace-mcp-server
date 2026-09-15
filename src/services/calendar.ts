import type { D2LApiClient } from "../api/index.js";
import { readList, object, rows, str, id, num, richText } from "./data.js";

const TYPES: Record<number, string> = { 1: "reminder", 2: "availability_start", 3: "availability_end", 4: "unlock_start", 5: "unlock_end", 6: "due_date" };
export async function fetchCalendar(api: D2LApiClient, courseIds: number[], start: string, end: string, timeZone = "UTC", occurrences = true) {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
  const local = (date: string | null) => date && Number.isFinite(Date.parse(date)) ? format.format(new Date(date)) : null;
  if (!courseIds.length) return { status: "available", events: [], recurrenceExpanded: occurrences, timeZone };
  const query = new URLSearchParams({ orgUnitIdsCSV: courseIds.join(","), startDateTime: start, endDateTime: end });
  let result = await readList(api, api.leGlobal(`/calendar/events/${occurrences ? "myEventsWithOccurrences" : "myEvents"}/?${query}`), 1000);
  let recurrenceExpanded = occurrences;
  if (occurrences && result.status === "not_found") {
    result = await readList(api, api.leGlobal(`/calendar/events/myEvents/?${query}`), 1000);
    recurrenceExpanded = false;
  }
  const events = (result.data ?? []).flatMap(raw => {
    const event = Object.keys(object(raw.EventDataInfo)).length ? object(raw.EventDataInfo) : raw;
    const occurrenceRows = rows(raw.Occurrences);
    const instances = occurrenceRows.length ? occurrenceRows : Array.isArray(raw.Occurrences) && event.IsRecurring === true ? [] : [event];
    return instances.map(instance => {
      const startDate = str(instance.StartDateTime), endDate = str(instance.EndDateTime);
      const associated = object(event.AssociatedEntity);
      return { id: event.CalendarEventId ?? null, recurrenceId: instance.RecurrenceId ?? null, courseId: id(event.OrgUnitId),
        courseName: str(event.OrgUnitName), title: str(event.Title), description: richText(event.Description),
        eventType: num(event.EventType), kind: TYPES[Number(event.EventType)] ?? "unknown", startDate, endDate,
        isAllDay: instance.IsAllDayEvent ?? event.IsAllDayEvent ?? null, startDay: instance.StartDay ?? event.StartDay ?? null,
        endDayExclusive: instance.EndDay ?? event.EndDay ?? null, localStart: local(startDate), localEnd: local(endDate),
        isRecurring: event.IsRecurring ?? null, recurrence: object(event.RecurrenceInfo),
        location: str(event.LocationName), associatedEntity: associated, sourceUrl: str(event.CalendarEventViewUrl) ?? str(associated.Link) };
    });
  }).filter(e => e.courseId === null || courseIds.includes(e.courseId))
    .sort((a, b) => String(a.startDate ?? a.startDay ?? "").localeCompare(String(b.startDate ?? b.startDay ?? "")));
  return { status: result.status, events, recurrenceExpanded, timeZone };
}
