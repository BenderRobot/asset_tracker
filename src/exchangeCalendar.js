// Published cash-equity calendars. Update each year from the venue, rather
// than extrapolating holidays or treating an old provider session as today's.
// NYSE 2026-28: https://www.nyse.com/trade/hours-calendars
// Nasdaq US 2026: https://www.nasdaq.com/market-activity/stock-market-holiday-schedule
// Euronext 2026: https://www.euronext.com/en/trading/trading-hours-holidays
// Xetra 2026-27: https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours
// Euronext's 2026 page confirms December half days but defers exact hours to
// a later year-end appendix. Keep `half` separate from a verified `early` hour.
import { getMarketOpenUTCHour, isCryptoTicker } from './MarketUtils.js';

const calendars = {
    us: {
        timezone: 'America/New_York',
        years: {
            2026: {
                closed: '01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25',
                early: { '11-27': 13, '12-24': 13 }
            },
            2027: {
                closed: '01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24',
                early: { '11-26': 13 }
            },
            2028: {
                closed: '01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25',
                early: { '07-03': 13, '11-24': 13 }
            }
        }
    },
    paris: {
        timezone: 'Europe/Paris',
        years: { 2026: {
            closed: '01-01 04-03 04-06 05-01 12-25',
            early: {}, half: '12-24 12-31'
        } }
    },
    amsterdam: {
        timezone: 'Europe/Amsterdam',
        years: { 2026: {
            closed: '01-01 04-03 04-06 05-01 12-25',
            early: {}, half: '12-24 12-31'
        } }
    },
    brussels: {
        timezone: 'Europe/Brussels',
        years: { 2026: {
            closed: '01-01 04-03 04-06 05-01 12-25',
            early: {}, half: '12-24 12-31'
        } }
    },
    milan: {
        timezone: 'Europe/Rome',
        years: { 2026: { closed: '01-01 04-03 04-06 05-01 12-24 12-25 12-31', early: {} } }
    },
    xetra: {
        timezone: 'Europe/Berlin',
        years: {
            2026: { closed: '01-01 04-03 04-06 05-01 12-24 12-25 12-26 12-31', early: {} },
            2027: { closed: '01-01 03-26 03-29 05-01 12-24 12-25 12-26 12-31', early: {} }
        }
    }
};

function venueForTicker(ticker) {
    const symbol = String(ticker || '').toUpperCase();
    if (!symbol || symbol.startsWith('CASH-') || symbol.includes('=') || isCryptoTicker(symbol)) return null;
    if (symbol === '^FCHI' || symbol.endsWith('.PA')) return 'paris';
    if (symbol.endsWith('.AS')) return 'amsterdam';
    if (symbol.endsWith('.BR')) return 'brussels';
    if (symbol.endsWith('.MI')) return 'milan';
    if (symbol === '^GDAXI' || symbol.endsWith('.DE')) return 'xetra';
    if (['^GSPC', '^NDX', '^IXIC', '^DJI', '^RUT'].includes(symbol)) return 'us';
    // Unsuffixed equity/ETF symbols in this app resolve to US cash markets.
    if (/^[A-Z][A-Z0-9-]*$/.test(symbol)) return 'us';
    return null;
}

export function exchangeCivilDay(timestamp, timezone) {
    try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
        }).formatToParts(timestamp).map(part => [part.type, part.value]));
        return { key: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
    } catch { return null; }
}

/** null means no published calendar covers this venue/year. */
export function getOfficialCalendarDay(ticker, at) {
    const market = venueForTicker(ticker);
    const config = calendars[market];
    if (!config) return null;
    const day = exchangeCivilDay(at, config.timezone);
    if (!day) return null;
    const year = config.years[Number(day.key.slice(0, 4))];
    if (!year) return null;
    const mmdd = day.key.slice(5);
    const weekend = day.weekday === 'Sat' || day.weekday === 'Sun';
    return {
        market, timezone: config.timezone, date: day.key,
        closed: weekend || year.closed.split(' ').includes(mmdd),
        earlyCloseHour: year.early[mmdd] ?? null,
        halfDay: year.half?.split(' ').includes(mmdd) || false,
        source: 'official-calendar'
    };
}

export function getOfficialEarlyCloseMs(day) {
    if (day?.earlyCloseHour == null) return null;
    const [year, month, date] = day.date.split('-').map(Number);
    const ref = new Date(Date.UTC(year, month - 1, date, 12));
    return Date.UTC(year, month - 1, date) + getMarketOpenUTCHour(day.earlyCloseHour, day.timezone, ref) * 3600000;
}

export function getOfficialRegularCloseMs(day) {
    if (!day?.halfDay) return null;
    const [year, month, date] = day.date.split('-').map(Number);
    const ref = new Date(Date.UTC(year, month - 1, date, 12));
    return Date.UTC(year, month - 1, date) + getMarketOpenUTCHour(17.5, day.timezone, ref) * 3600000;
}
