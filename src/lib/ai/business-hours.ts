/**
 * Business-hours gate for the AI auto-reply bot.
 *
 * No date library dependency -- `Intl.DateTimeFormat` with a `timeZone`
 * option is enough to read the wall-clock hour/weekday in the
 * account's configured zone without pulling in date-fns/luxon just
 * for this.
 */

export interface BusinessHoursConfig {
  enabled: boolean
  /** 0-23, inclusive start hour. */
  startHour: number
  /** 1-24, exclusive end hour (24 means "until midnight"). */
  endHour: number
  /** IANA timezone, e.g. 'America/Sao_Paulo'. */
  timezone: string
}

interface WallClock {
  weekday: number // 0 = Sunday .. 6 = Saturday
  hour: number
  minute: number
}

function wallClockIn(date: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)

  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  const minuteStr = parts.find((p) => p.type === 'minute')?.value ?? '0'

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    weekday: WEEKDAYS.indexOf(weekdayStr),
    // Intl can format midnight as "24" under hour12:false in some
    // environments -- normalize.
    hour: Number(hourStr) % 24,
    minute: Number(minuteStr),
  }
}

/** Mon-Fri, within [startHour, endHour) in the configured timezone. */
export function isWithinBusinessHours(
  config: BusinessHoursConfig,
  at: Date = new Date(),
): boolean {
  if (!config.enabled) return true
  const { weekday, hour } = wallClockIn(at, config.timezone)
  const isWeekday = weekday >= 1 && weekday <= 5
  return isWeekday && hour >= config.startHour && hour < config.endHour
}

/**
 * Next moment business hours open, strictly after `from`. Walks
 * forward day by day (bounded to 8 days as a safety net) rather than
 * doing timezone arithmetic by hand -- correctness over cleverness,
 * and 8 iterations is free.
 */
export function nextBusinessHourStart(
  config: BusinessHoursConfig,
  from: Date = new Date(),
): Date {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidateDay = new Date(from.getTime() + dayOffset * 86_400_000)
    const { weekday } = wallClockIn(candidateDay, config.timezone)
    if (weekday < 1 || weekday > 5) continue

    const candidateStart = atLocalHour(candidateDay, config.timezone, config.startHour)
    if (candidateStart.getTime() > from.getTime()) return candidateStart
  }
  // Unreachable in practice (a Mon-Fri window always recurs within a
  // week) -- fall back to "in 24h" rather than throwing.
  return new Date(from.getTime() + 86_400_000)
}

/**
 * Build a Date for `hour`:00 local time on the same calendar day as
 * `reference`, in `timezone`. Works by reading the timezone's current
 * UTC offset (via the reference instant) and applying it -- accurate
 * for the near-term "next few days" horizon this is used for; not
 * meant for DST-boundary-crossing long-range scheduling.
 */
function atLocalHour(reference: Date, timezone: string, hour: number): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)

  // Offset (minutes) between UTC and the target zone at this instant.
  const offsetMinutes = getTimezoneOffsetMinutes(reference, timezone)
  // Construct the UTC instant that corresponds to `hour`:00 local time
  // on (y, m, d) in that zone: local = UTC + offset, so UTC = local - offset.
  const utcMillis = Date.UTC(y, m - 1, d, hour, 0, 0) - offsetMinutes * 60_000
  return new Date(utcMillis)
}

function getTimezoneOffsetMinutes(date: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return (asUTC - date.getTime()) / 60_000
}
