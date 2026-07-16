// Re-export shim (P10): the report serializers moved to @asset-doctor/budget so the CLI emits the SAME
// JSON/MD/CSV/HTML artifacts (`asset-doctor audit --html`) — one source, zero drift between the web
// export buttons and CI output. Existing web imports keep this path; tests moved with the module
// (packages/budget/test/report-export.test.ts).
export {
  reportToJSON,
  reportToMarkdown,
  reportToCSV,
  reportToHTML,
  reportContent,
  reportFilename,
  sortFindings,
  escapeHtml,
  REPORT_MIME,
  type ReportFormat,
} from '@asset-doctor/budget';
