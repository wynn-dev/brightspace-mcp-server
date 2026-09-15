import { makePdf } from "./pdf.js";

export function studentCourseFixture() {
  const now = Date.now();
  const date = (days: number) => new Date(now + days * 86400000).toISOString();
  const fixtures: Record<string, unknown> = {};
  const lp = (path: string, body: unknown) => { fixtures[`/d2l/api/lp/1.63${path}`] = { body }; };
  const le = (path: string, body: unknown) => { fixtures[`/d2l/api/le/1.97${path}`] = { body }; };
  const pdf = makePdf(["Matrix lecture page one", "Matrix lecture page two"]);
  const file = (path: string, body: Buffer | string, mime: string, name: string) => {
    fixtures[`/d2l/api/le/1.97/5${path}`] = { binary: Buffer.from(body).toString("base64"),
      headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${name}"` } };
  };
  fixtures["/d2l/api/versions/"] = { body: [{ ProductCode: "lp", LatestVersion: "1.63" }, { ProductCode: "le", LatestVersion: "1.97" }] };
  lp("/users/whoami", { Identifier: "42" });
  lp("/enrollments/myenrollments/", { Items: [{ OrgUnit: { Id: 5, Name: "Matrix methods", Code: "MATH" },
    Access: { IsActive: true, ClasslistRoleName: "Student" } }] });
  lp("/courses/5", { Name: "Matrix methods", Description: { Text: "Matrix course" }, Semester: { Name: "Autumn" } });
  const folder = { Id: 1, Name: "Matrix report", SubmissionType: 0, DropboxType: 1, GroupTypeId: 2, IsHidden: false,
    DueDate: date(2), CustomInstructions: { Text: "Solve the matrix" }, Assessment: { ScoreDenominator: 10 }, Availability: {} };
  le("/5/dropbox/folders/", [folder]); le("/5/dropbox/folders/1", folder);
  le("/5/dropbox/folders/1/submissions/mysubmissions/", [{ Entity: { EntityId: 3, EntityType: "Group" },
    Submissions: [{ Id: 10, SubmissionDate: date(-2), Files: [{ FileId: 20, FileName: "report.pdf", Size: pdf.length }] },
      { Id: 11, SubmissionDate: date(-1), Files: [] }],
    Feedback: { IsGraded: true, Score: 8, Feedback: { Text: "Good work" }, RubricAssessments: [{ RubricId: 4 }] } }]);
  le("/5/quizzes/", [{ QuizId: 2, Name: "Matrix quiz", IsActive: true, DueDate: date(1),
    AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 3 },
    SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 30 } }]);
  le("/5/quizzes/2/attempts/", [
    { AttemptId: 1, UserId: 42, AttemptNumber: 1, Completed: date(-1), IsPublished: true, Score: 8 },
    { AttemptId: 2, UserId: 42, AttemptNumber: 2, Started: date(0), Completed: null, IsPublished: false, Score: 999,
      AttemptFeedback: { Text: "UNRELEASED_SECRET" } },
    { AttemptId: 3, UserId: 99, AttemptNumber: 1, IsPublished: true, Score: 999 },
  ]);
  const grade = { GradeObjectIdentifier: "1", GradeObjectName: "Report", PointsNumerator: 8, PointsDenominator: 10,
    DisplayedGrade: "80%", Comments: { Text: "Good work" }, PrivateComments: { Text: "PRIVATE_SECRET" } };
  le("/5/grades/values/myGradeValues/", [grade]);
  le("/5/grades/", [{ Id: 1, Name: "Report", MaxPoints: 10, CategoryId: 0, GradeType: "Numeric", IsBonus: false,
    IsHidden: false, CanExceedMaxPoints: false, ExcludeFromFinalGradeCalculation: false }]);
  le("/5/grades/categories/", []); le("/5/grades/setup/", { GradingSystem: "Points", IsNullGradeZero: false });
  le("/5/grades/exemptions/42", { Items: [{ GradeObjectId: 1, IsExempt: false, GradeValue: { PointsNumerator: 999 } }] });
  le("/5/grades/final/values/myGradeValue", { DisplayedGrade: "80%", PointsNumerator: 8, PointsDenominator: 10 });
  le("/5/news/", [{ Id: 1, Title: "Matrix news", Body: { Text: "Read the matrix notes" }, IsPublished: true, CreatedDate: date(-1), LastModifiedDate: date(0) }]);
  le("/updates/myUpdates/", [{ OrgUnitId: 5, UnreadDiscussionPosts: 1 }]);
  lp("/feed/", [{ Type: "News", Metadata: { OrgUnitId: 5, Date: date(-1) }, Resource: { Id: 1, Title: "Matrix news" } }]);
  const event = { CalendarEventId: "1", OrgUnitId: 5, Title: "Matrix deadline", EventType: 6,
    StartDateTime: date(2), EndDateTime: date(2), IsRecurring: true };
  le("/calendar/events/myEvents/", [event]);
  le("/calendar/events/myEventsWithOccurrences/", [{ EventDataInfo: event, Occurrences: [
    { RecurrenceId: "r1", StartDateTime: date(2), EndDateTime: date(2), IsAllDayEvent: false },
    { RecurrenceId: "r2", StartDay: date(3).slice(0, 10), EndDay: date(4).slice(0, 10), IsAllDayEvent: true },
  ] }]);
  le("/5/content/root/", [{ Id: 100, Type: 0, Title: "Matrix lectures", IsHidden: false, IsLocked: false }]);
  const topics = [101, 102, 103].map(Id => ({ Id, TopicId: Id, Type: 1, TopicType: 1, Title: "Matrix notes", IsHidden: false, IsLocked: false }));
  le("/5/content/modules/100/structure/", topics);
  le("/5/content/toc", { Modules: [{ ModuleId: 100, Title: "Matrix lectures", Topics: topics }] });
  le("/5/content/myItems/", [{ ItemId: 101, ItemName: "Matrix notes", CompletionType: 2, DateCompleted: null, DueDate: date(1) }]);
  for (const topic of topics) le(`/5/content/topics/${topic.Id}`, topic);
  file("/content/topics/101/file", pdf, "application/pdf", "notes.pdf");
  file("/content/topics/102/file", "<h1>Matrix HTML</h1><p>Lesson</p><script>PRIVATE_SECRET</script>", "text/html", "notes.html");
  file("/content/topics/103/file", "Matrix plain text", "text/plain", "notes.txt");
  le("/5/overview", { Description: { Text: "Matrix syllabus", Html: "" } });
  file("/overview/attachment", pdf, "application/pdf", "syllabus");
  file("/dropbox/folders/1/submissions/10/files/20/download", pdf, "application/pdf", "report.pdf");
  lp("/5/groupcategories/", [{ GroupCategoryId: 2, Name: "Project teams" }]);
  lp("/5/groupcategories/2/groups/", [{ GroupId: 3, Name: "Our group", Enrollments: [42, 43] }, { GroupId: 4, Name: "Other group", Enrollments: [99] }]);
  lp("/5/sections/mysections/", [{ SectionId: 1, Name: "Section A" }]);
  le("/5/checklists/", [{ Id: 2, Name: "Matrix preparation" }]);
  le("/5/checklists/2/categories/", [{ CategoryId: 3, Name: "Reading" }]);
  le("/5/checklists/2/items/", { Objects: [{ ChecklistItemId: 4, CategoryId: 3, Name: "Read" }], Next: "/d2l/api/le/1.97/5/checklists/2/items/?page=2" });
  le("/5/checklists/2/items/?page=2", { Objects: [{ ChecklistItemId: 5, CategoryId: 3, Name: "Try" }], Next: null });
  le("/5/classlist/paged/", { Objects: [{ Identifier: 7, DisplayName: "Instructor", Email: "instructor@example.invalid", ClasslistRoleDisplayName: "Lecturer" }], Next: null });
  le("/5/discussions/forums/", [{ ForumId: 1, Name: "Matrix forum" }]);
  le("/5/discussions/forums/1/topics/", [{ TopicId: 10, Name: "Matrix topic" }]);
  le("/5/discussions/forums/1/topics/10", { TopicId: 10, Name: "Matrix topic" });
  le("/5/discussions/forums/1/topics/10/posts/", [{ PostId: 1, ThreadId: 1, Subject: "Matrix question", Message: { Text: "Matrix help" }, PostingUserId: 42, IsRead: false, DatePosted: date(-1) }]);
  return fixtures;
}
