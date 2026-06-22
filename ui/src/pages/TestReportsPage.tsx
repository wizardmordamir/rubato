import { TestReportViewer } from "cursedbelt/react";
import { fetchTestReport, fetchTestReportSummaries, testReportArtifactUrl } from "../api";
import { PageHeading } from "../components";

// Functional & e2e run reports the test runner wrote (cwip TestRunReport). The
// list/detail UI + debug-artifact rendering (screenshots, page HTML, console/
// network logs) is the shared cwip/react <TestReportViewer>; this page only injects
// rubato's transport.
export function TestReportsPage() {
  return (
    <div>
      <PageHeading title="Test Reports" />
      <p className="mb-4 text-sm text-gray-500">
        Functional &amp; e2e runs. Run <code className="text-xs">bun run test:report</code> to produce one.
      </p>
      <TestReportViewer
        fetchSummaries={fetchTestReportSummaries}
        fetchReport={fetchTestReport}
        artifactUrl={testReportArtifactUrl}
      />
    </div>
  );
}
