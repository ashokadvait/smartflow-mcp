import { ValidationError } from "./errors.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 365;

/**
 * Parse a Smartflo timestamp (typically IST "YYYY-MM-DD HH:mm:ss" with no offset) into a UTC Date.
 */
export function parseSmartfloTimestamp(
  dateStr?: string | null,
  timeStr?: string | null,
  timezone = "Asia/Kolkata"
): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // If already ISO with offset or Z, parse directly
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const combined = timeStr ? `${trimmed} ${timeStr.trim()}` : trimmed;
  const match = combined.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) {
    const fallback = new Date(combined);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, y, m, d, hh = "00", mm = "00", ss = "00"] = match;
  const utcMillis = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss)
  );

  if (timezone === "Asia/Kolkata" || timezone === "IST") {
    return new Date(utcMillis - IST_OFFSET_MS);
  }
  if (timezone === "UTC") {
    return new Date(utcMillis);
  }

  // General IANA timezone offset calculation via Intl
  const approx = new Date(utcMillis);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(approx);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const tzAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second")
  );
  const offset = tzAsUtc - utcMillis;
  return new Date(utcMillis - offset);
}

/**
 * Format a UTC Date into Smartflo API query format "YYYY-MM-DD HH:mm:ss" in IST (or given timezone).
 */
export function formatForSmartfloQuery(date: Date, timezone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

/**
 * Convert a calendar date string (YYYY-MM-DD) in a timezone to [startUtc, endUtcExclusive].
 */
export function getDayBoundsUtc(
  dateYmd: string,
  timezone = "Asia/Kolkata"
): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    throw new ValidationError(`Invalid date format "${dateYmd}". Expected YYYY-MM-DD.`);
  }
  const from = parseSmartfloTimestamp(`${dateYmd} 00:00:00`, undefined, timezone);
  if (!from) {
    throw new ValidationError(`Could not parse date "${dateYmd}"`);
  }
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * Validate and bound a [from, to] date range.
 */
export function validateDateRange(
  fromInput: string | Date,
  toInput: string | Date,
  maxDays = MAX_RANGE_DAYS
): { from: Date; to: Date } {
  const from = fromInput instanceof Date ? fromInput : new Date(fromInput);
  const to = toInput instanceof Date ? toInput : new Date(toInput);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError("Invalid from/to date range.");
  }
  if (from >= to) {
    throw new ValidationError("'from' must be strictly before 'to'.");
  }
  const diffDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (diffDays > maxDays) {
    throw new ValidationError(`Date range exceeds maximum allowed window of ${maxDays} days.`);
  }
  return { from, to };
}

/**
 * Get today's date in YYYY-MM-DD for a given timezone.
 */
export function getTodayYmd(timezone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

