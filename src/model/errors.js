const QUOTA_STATUSES = new Set([402, 403, 429]);
const QUOTA_PATTERN = /quota|daily|per[ -_]?day|insufficient[ _]credits|out of credits|billing/i;

export function isQuotaError(status, bodyText) {
  return QUOTA_STATUSES.has(Number(status)) && QUOTA_PATTERN.test(bodyText);
}

export function quotaMessage(status, bodyText) {
  return `API quota exhausted (HTTP ${status}); not retrying. Use another key or wait for the quota to reset. Details: ${bodyText.slice(0, 200)}`;
}
