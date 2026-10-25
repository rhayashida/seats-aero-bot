import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

const API_BASE = 'https://seats.aero/partnerapi';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

const cfg = {
  apiKey: required('SEATS_AERO_API_KEY'),
  origin: env('ORIGIN_AIRPORT', 'ORD'),
  // Any of these Italian airports may be used on either end — outbound can land at one and
  // the return can depart from another (open-jaw), since the API is queried with all of them
  // at once via a comma-delimited airport list.
  italyAirports: env('ITALY_AIRPORTS', 'LIN,FCO,MXP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  outboundStart: required('OUTBOUND_START_DATE'),
  outboundEnd: required('OUTBOUND_END_DATE'),
  returnStart: required('RETURN_START_DATE'),
  returnEnd: required('RETURN_END_DATE'),
  // Mileage programs to query. flyingblue = Air France/KLM's own program; united = United
  // MileagePlus; lufthansa = Lufthansa Miles & More, which also covers Swiss (LX) award space.
  sources: env('SOURCES', 'flyingblue,united,lufthansa').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  carriers: env('CARRIERS', 'AF,KL,UA,LH,LX').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  passengers: parseInt(env('PASSENGERS', '2'), 10),
  cabin: env('CABIN', 'business'),
  maxPoints: parseInt(env('MAX_POINTS_PER_PASSENGER', '80000'), 10),
  maxCopay: parseFloat(env('MAX_COPAY_USD_PER_PASSENGER', '800')),
  maxLayoverMinutes: parseInt(env('MAX_LAYOVER_MINUTES', '180'), 10),
  maxStops: parseInt(env('MAX_STOPS', '1'), 10),
  maxRequestsPerDay: parseInt(env('MAX_REQUESTS_PER_DAY', '1000'), 10),
  stateFile: path.resolve(env('STATE_FILE', './state.json')),
};

// Connecting airports on 1-stop itineraries must fall in this set (mainland Europe, UK,
// Ireland, Switzerland, Nordics, etc.) — realistically AF/KL-only routings connect via CDG/ORY
// (Air France, Paris) or AMS (KLM, Amsterdam), but this is checked generally rather than
// hard-coded to just those two, per the "layover must be in Europe" requirement.
const EUROPEAN_AIRPORTS = new Set([
  'LHR', 'LGW', 'LCY', 'STN', 'LTN', 'MAN', 'EDI', 'GLA', 'BHX', 'BRS',
  'DUB', 'SNN', 'ORK',
  'CDG', 'ORY', 'NCE', 'LYS', 'MRS', 'TLS', 'BOD', 'NTE', 'RNS', 'BIQ',
  'AMS', 'EIN', 'RTM', 'GRQ',
  'BRU', 'CRL', 'ANR', 'LGG',
  'LUX',
  'FRA', 'MUC', 'DUS', 'TXL', 'BER', 'HAM', 'CGN', 'STR', 'NUE', 'HAJ', 'LEJ', 'DRS',
  'ZRH', 'GVA', 'BSL', 'BRN',
  'VIE', 'SZG', 'INN', 'GRZ',
  'FCO', 'MXP', 'LIN', 'VCE', 'BLQ', 'NAP', 'CTA', 'PMO', 'CAG', 'BRI', 'TRN', 'FLR', 'PSA', 'BGY', 'TSF', 'VRN', 'OLB', 'BDS', 'AHO',
  'MAD', 'BCN', 'PMI', 'AGP', 'VLC', 'SVQ', 'BIO', 'ALC', 'LPA', 'TFS', 'IBZ',
  'LIS', 'OPO', 'FAO', 'FNC', 'PDL',
  'ATH', 'SKG', 'HER', 'RHO', 'CHQ', 'JTR', 'JMK',
  'OSL', 'BGO', 'TRD', 'SVG',
  'ARN', 'GOT', 'MMX',
  'CPH', 'BLL',
  'HEL', 'TMP',
  'KEF',
  'WAW', 'KRK', 'GDN', 'WRO', 'POZ', 'KTW',
  'PRG', 'BRQ',
  'BUD',
  'OTP', 'CLJ',
  'SOF',
  'ZAG', 'SPU', 'DBV', 'PUY', 'ZAD',
  'LJU',
  'BEG',
  'BTS',
  'TLL', 'RIX', 'VNO', 'KUN',
  'MLA', 'LCA',
]);

async function loadState() {
  try {
    const raw = await fs.readFile(cfg.stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.notified) parsed.notified = {};
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { date: null, requestCount: 0, notified: {} };
    throw err;
  }
}

async function saveState(state) {
  await fs.writeFile(cfg.stateFile, JSON.stringify(state, null, 2));
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay(state) {
  const today = todayUTC();
  if (state.date !== today) {
    state.date = today;
    state.requestCount = 0;
  }
  return state;
}

function pruneNotified(state) {
  const cutoffMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [id, rec] of Object.entries(state.notified)) {
    if (new Date(rec.notifiedAt).getTime() < cutoffMs) delete state.notified[id];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries only on network-level failures (DNS/connection not ready yet — common right after
// the Mac wakes from sleep), not on HTTP error responses from the API itself.
async function fetchJsonWithRetry(url) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'Partner-Authorization': cfg.apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        console.error(
          `[${new Date().toISOString()}] Network error on attempt ${attempt}/${maxAttempts} (${err.message}); retrying in 10s...`
        );
        await sleep(10000);
        continue;
      }
      throw new Error(`Network error after ${maxAttempts} attempts: ${err.message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Seats.aero API error ${res.status}: ${body.slice(0, 500)}`);
    }

    return res.json();
  }
}

async function callSearch(state, params) {
  if (state.requestCount >= cfg.maxRequestsPerDay) {
    console.warn(`Daily request budget (${cfg.maxRequestsPerDay}) already used; skipping call.`);
    return null;
  }

  const url = new URL(`${API_BASE}/search`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Count the call before it fires so a crash mid-request never loses track of budget spent.
  state.requestCount += 1;
  await saveState(state);

  return fetchJsonWithRetry(url);
}

// The /search endpoint's trip summaries (even with include_trips=true) come back with an empty
// AvailabilitySegments array — full per-segment timing only comes from this separate endpoint.
// Only called for candidates that already passed the cheap summary-level filters, since exact
// layover timing is the one thing the summary can't tell us.
async function callTripDetails(state, availabilityId) {
  if (state.requestCount >= cfg.maxRequestsPerDay) {
    console.warn(`Daily request budget (${cfg.maxRequestsPerDay}) already used; skipping trip detail lookup.`);
    return null;
  }

  const url = new URL(`${API_BASE}/trips/${availabilityId}`);

  state.requestCount += 1;
  await saveState(state);

  return fetchJsonWithRetry(url);
}

function minutesBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000;
}

function carrierOfFlightNumber(fn) {
  const m = /^([A-Z]{2,3})\s?\d+/.exec((fn || '').trim());
  return m ? m[1] : null;
}

// Cheap filters using only the /search trip summary — no segment-level detail needed.
function evaluateTripSummary(trip) {
  if (!trip || (trip.Cabin || '').toLowerCase() !== cfg.cabin.toLowerCase()) return null;
  if ((trip.RemainingSeats ?? 0) < cfg.passengers) return null;
  if ((trip.MileageCost ?? Infinity) > cfg.maxPoints) return null;

  const taxes = (trip.TotalTaxes ?? 0) / 100;
  if (taxes > cfg.maxCopay) return null;

  if ((trip.Stops ?? 0) > cfg.maxStops) return null;

  const carriers = (trip.Carriers || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (carriers.length === 0) return null;
  for (const c of carriers) {
    if (!cfg.carriers.includes(c)) return null;
  }

  // Every connecting airport must be in Europe.
  for (const connectionAirport of trip.Connections || []) {
    if (!EUROPEAN_AIRPORTS.has(connectionAirport)) return null;
  }

  return { trip, taxes };
}

// Precise per-leg layover check using real segment timestamps, fetched only for candidates that
// already passed evaluateTripSummary (so this extra API call stays rare). Returns the trip's
// real segments if it also clears the layover bar, or null if it doesn't.
async function fetchAndCheckSegments(state, trip) {
  if (trip.Stops === 0) {
    // Nonstop: no layover to check. Synthesize a single "segment" from the summary fields so
    // formatMatch has something to render.
    return [
      {
        FlightNumber: trip.FlightNumbers,
        OriginAirport: trip.OriginAirport,
        DestinationAirport: trip.DestinationAirport,
        DepartsAt: trip.DepartsAt,
        ArrivesAt: trip.ArrivesAt,
      },
    ];
  }

  const data = await callTripDetails(state, trip.AvailabilityID);
  if (!data) return null;

  const fullTrip = (data.data || []).find((t) => t.ID === trip.ID);
  if (!fullTrip) return null;

  const segments = [...(fullTrip.AvailabilitySegments || [])].sort((a, b) => a.Order - b.Order);
  if (segments.length === 0) return null;

  // Defense in depth: re-check carrier per actual segment, not just the summary's Carriers field.
  for (const seg of segments) {
    const carrier = carrierOfFlightNumber(seg.FlightNumber);
    if (!carrier || !cfg.carriers.includes(carrier)) return null;
  }

  for (let i = 0; i < segments.length - 1; i++) {
    const gap = minutesBetween(segments[i].ArrivesAt, segments[i + 1].DepartsAt);
    if (gap < 0 || gap > cfg.maxLayoverMinutes) return null;
  }

  return segments;
}

async function searchDirection(state, { label, origin, destination, startDate, endDate }) {
  const data = await callSearch(state, {
    origin_airport: origin,
    destination_airport: destination,
    start_date: startDate,
    end_date: endDate,
    cabins: cfg.cabin,
    sources: cfg.sources.join(','),
    carriers: cfg.carriers.join(','),
    include_trips: 'true',
    take: '1000',
  });
  if (!data) return [];

  const candidates = [];
  for (const item of data.data || []) {
    for (const trip of item.AvailabilityTrips || []) {
      const evaluated = evaluateTripSummary(trip);
      if (evaluated) candidates.push(evaluated);
    }
  }

  const matches = [];
  for (const { trip, taxes } of candidates) {
    const segments = await fetchAndCheckSegments(state, trip);
    if (segments) matches.push({ label, trip, segments, taxes });
  }
  return matches;
}

function fmtTime(iso) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function formatMatch({ label, trip, segments, taxes }) {
  const routeAirports = segments.map((s) => s.OriginAirport).concat(segments[segments.length - 1].DestinationAirport);
  const segLines = segments
    .map((s) => `  ${s.FlightNumber}  ${s.OriginAirport} -> ${s.DestinationAirport}   ${fmtTime(s.DepartsAt)} -> ${fmtTime(s.ArrivesAt)}`)
    .join('\n');

  return [
    `[${label}] ${routeAirports.join(' -> ')}`,
    `Departs: ${fmtTime(trip.DepartsAt)}`,
    `Cabin: ${trip.Cabin}  |  Points: ${Number(trip.MileageCost).toLocaleString()}/passenger  |  Taxes/fees: $${taxes.toFixed(2)}/passenger`,
    `Seats remaining: ${trip.RemainingSeats}  |  Stops: ${trip.Stops}  |  Total duration: ${trip.TotalDuration} min`,
    segLines,
    `Source: ${trip.Source}  |  Trip ID: ${trip.ID}`,
  ].join('\n');
}

async function sendEmail(matches) {
  const transporter = nodemailer.createTransport({
    host: env('SMTP_HOST', 'smtp.gmail.com'),
    port: parseInt(env('SMTP_PORT', '465'), 10),
    secure: env('SMTP_SECURE', 'true') === 'true',
    auth: { user: required('SMTP_USER'), pass: required('SMTP_PASS') },
  });

  const subject = `Award alert: ${matches.length} ${cfg.origin}<->Italy business match${matches.length > 1 ? 'es' : ''} found`;
  const text = matches.map(formatMatch).join('\n\n---\n\n');
  const html = `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(text)}</pre>`;

  await transporter.sendMail({
    from: required('EMAIL_FROM'),
    to: required('EMAIL_TO'),
    subject,
    text,
    html,
  });
}

async function main() {
  const state = resetIfNewDay(await loadState());
  pruneNotified(state);

  const italy = cfg.italyAirports.join(',');
  const directions = [
    { label: 'OUTBOUND', origin: cfg.origin, destination: italy, startDate: cfg.outboundStart, endDate: cfg.outboundEnd },
    { label: 'RETURN', origin: italy, destination: cfg.origin, startDate: cfg.returnStart, endDate: cfg.returnEnd },
  ];

  const allMatches = [];
  let failedDirections = 0;
  for (const dir of directions) {
    try {
      allMatches.push(...(await searchDirection(state, dir)));
    } catch (err) {
      failedDirections += 1;
      console.error(`[${new Date().toISOString()}] Error searching ${dir.label}: ${err.message}`);
    }
  }

  const newMatches = allMatches.filter((m) => !state.notified[m.trip.ID]);

  const warning = failedDirections > 0 ? ` WARNING: ${failedDirections}/${directions.length} direction(s) failed to search.` : '';
  console.log(
    `[${new Date().toISOString()}] Checked. Requests used today: ${state.requestCount}/${cfg.maxRequestsPerDay}. ` +
      `Matches: ${allMatches.length} (${newMatches.length} new).${warning}`
  );

  if (newMatches.length > 0) {
    await sendEmail(newMatches);
    for (const m of newMatches) state.notified[m.trip.ID] = { notifiedAt: new Date().toISOString() };
    console.log(`Emailed ${newMatches.length} new match(es) to ${env('EMAIL_TO')}`);
  }

  await saveState(state);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
