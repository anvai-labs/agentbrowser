/** T10 M5: deliberately limited to custom public research identity markers. */
export interface ResearchRequestHeader {
  header: string;
  value: string;
  hostSuffix?: string;
}

export function requestHeaderIssues(headers: ResearchRequestHeader[]): string[] {
  const issues: string[] = [];
  const names = new Set<string>();
  let bytes = 0;
  if (headers.length < 1 || headers.length > 16) issues.push('requestHeaders needs 1–16 entries');
  for (const [index, entry] of headers.entries()) {
    const name = entry.header.toLowerCase();
    if (
      !/^x-[a-z0-9][a-z0-9-]{0,61}$/.test(name) ||
      /^x-(forwarded(?:-|$)|real-ip$|original-|rewrite-|http-method|api-key$|authorization$|auth(?:-|$)|csrf-|xsrf-|amz-|goog-|ms-)/.test(
        name
      )
    )
      issues.push(
        `requestHeaders[${index}].header must be a custom research marker, not a transport or credential header`
      );
    if (names.has(name)) issues.push(`requestHeaders[${index}].header is duplicated`);
    names.add(name);
    if (!/^[\x20-\x7e]{1,1024}$/.test(entry.value))
      issues.push(`requestHeaders[${index}].value must be 1–1024 printable ASCII bytes`);
    bytes += Buffer.byteLength(entry.header) + Buffer.byteLength(entry.value);
  }
  if (bytes > 8192) issues.push('requestHeaders exceeds 8192 name/value bytes');
  return issues;
}
