import type { TimezoneTransition } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

function offsetMinutes(timestamp: number) {
  return -new Date(timestamp).getTimezoneOffset()
}

export function browserTimezone(minDate: string, maxDate: string) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const start = Date.parse(`${minDate}T00:00:00Z`)
  const end = Date.parse(`${maxDate}T00:00:00Z`) + (2 * DAY_MS)
  let previousSample = start
  let previousOffset = offsetMinutes(start)
  const timezoneTransitions: TimezoneTransition[] = [{
    startsAt: new Date(start).toISOString(),
    offsetMinutes: previousOffset,
  }]

  for (let sample = start + DAY_MS; sample <= end; sample += DAY_MS) {
    const nextOffset = offsetMinutes(sample)
    if (nextOffset !== previousOffset) {
      let low = previousSample
      let high = sample
      while (high - low > MINUTE_MS) {
        const middle = Math.floor((low + high) / (2 * MINUTE_MS)) * MINUTE_MS
        if (offsetMinutes(middle) === previousOffset) low = middle
        else high = middle
      }
      timezoneTransitions.push({
        startsAt: new Date(high).toISOString(),
        offsetMinutes: nextOffset,
      })
      previousOffset = nextOffset
    }
    previousSample = sample
  }

  return { timezone, timezoneTransitions }
}
