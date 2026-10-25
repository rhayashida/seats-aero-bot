# Seats.aero award flight bot

Polls Seats.aero for Air France / KLM / United / Lufthansa / Swiss business class award space
between Chicago (ORD) and Italy (Milan Linate, Milan Malpensa, or Rome Fiumicino), for 2
passengers, and emails you when a qualifying itinerary appears.

**Filters applied to every itinerary:**
- Outbound ORD → any of LIN / FCO / MXP, departing Jan 5, 6, or 7
- Return any of LIN / FCO / MXP → ORD, departing Jan 18, 19, or 20
  (open-jaw is fine — e.g. outbound into LIN, return from FCO)
- Business cabin, flown entirely on Air France (AF), KLM (KL), United (UA), Lufthansa (LH), or
  Swiss (LX)
- At most 1 stop, and if there is one, the connecting airport must be in Europe
- Every connection ≤ 3 hours
- At least 2 seats remaining
- ≤ 90,000 points per passenger
- ≤ $800 taxes/fees (copay) per passenger

Each qualifying itinerary is only emailed once (tracked in `state.json`), and the bot enforces
its own hard cap of 1,000 Seats.aero API calls/day. The baseline cost is 2 calls per run — one
per direction, each covering all 3 Italian airports and all 3 mileage programs at once via
comma-delimited parameters — plus 1 extra call for every itinerary that clears every other
filter but has a connection (see below), so at a 30-minute schedule that's normally ~96
calls/day, more only on days with several live candidates.

## 1. Install dependencies

```bash
cd ~/seats-aero-bot
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- `SEATS_AERO_API_KEY` — from your Seats.aero account (Pro plan required for the search API).
- `ITALY_AIRPORTS` — comma-delimited list of Italian airports to consider (defaults to
  `LIN,FCO,MXP`).
- Confirm the year in `OUTBOUND_START_DATE` / `OUTBOUND_END_DATE` / `RETURN_START_DATE` /
  `RETURN_END_DATE` — defaults assume January 2027 since January 2026 has already passed.
- `SMTP_USER` / `SMTP_PASS` — a Gmail address and an
  [App Password](https://myaccount.google.com/apppasswords) (requires 2-Step Verification
  enabled on that Google account; your normal Gmail password will not work here).
- `EMAIL_TO` — where alerts should be sent.

## 3. Test it manually

```bash
npm run check
```

You should see a log line like:

```
[2026-09-10T...] Checked. Requests used today: 2/1000. Matches: 0 (0 new).
```

If it errors, fix that before scheduling it (see error messages for missing env vars, bad
API key, or SMTP auth failures).

## 4. Schedule it (launchd)

A plist is provided, defaulting to every 30 minutes. It assumes node lives at
`/opt/homebrew/bin/node` — check with `which node` and edit the plist if yours differs.

```bash
cp com.robhayashida.seatsaerobot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.robhayashida.seatsaerobot.plist
```

This job lives outside `~/Documents` on purpose — macOS blocks background/launchd processes
from reading files under `~/Documents`, `~/Desktop`, and `~/Downloads` even though your own
Terminal session can read them fine, so keep this folder where it is.

`StartInterval` jobs only fire while the Mac is awake — launchd does not wake a sleeping Mac on
its own. Current setup: run `sudo pmset -c sleep 0` to keep the Mac awake whenever it's plugged
into power (checks fire every 30 min); on battery it's left alone and will sleep normally
(checks pause until it next wakes). The job itself survives sleep/wake/reboot/logout
automatically — no need to reload it after any of those.

**Useful commands:**
```bash
# Check logs
tail -f ~/seats-aero-bot/bot.log ~/seats-aero-bot/bot.error.log

# Stop the schedule
launchctl unload ~/Library/LaunchAgents/com.robhayashida.seatsaerobot.plist

# Restart after editing .env or check.js
launchctl unload ~/Library/LaunchAgents/com.robhayashida.seatsaerobot.plist
launchctl load ~/Library/LaunchAgents/com.robhayashida.seatsaerobot.plist
```

## Notes / assumptions

- "Copay not to exceed $800" is treated as **per passenger** (matching the per-passenger points
  cap). Change `MAX_COPAY_USD_PER_PASSENGER` in `.env` if you meant a combined total instead.
- Searches query 3 mileage programs at once (`flyingblue`, `united`, `lufthansa` — the latter
  also covers Swiss/LX award space), plus a `carriers=AF,KL,UA,LH,LX` filter.
- **How matching actually works (2-stage, because of a real API quirk):** Seats.aero's `/search`
  endpoint returns a summary per itinerary (cabin, points, taxes, stops, carriers, connecting
  airport codes) but — even with `include_trips=true` — its `AvailabilitySegments` array is
  always empty, so exact per-flight departure/arrival times aren't available there. `check.js`
  first filters on the cheap summary fields (cabin, seats, points, taxes, stop count, carriers,
  "connection is in Europe"), then, only for itineraries that clear all of those, makes one more
  call to `/trips/{AvailabilityID}` to fetch real segment timestamps and check the exact
  per-leg layover against the 3-hour cap. Nonstop itineraries skip this second call entirely
  since there's no layover to check. (Earlier versions of this bot checked layovers directly
  against `AvailabilitySegments` from `/search`, which is always empty — meaning every itinerary
  was silently rejected regardless of whether it actually qualified. Fixed 2026-09-23.)
- The "connection must be in Europe" check uses a static list of ~150 European airport IATA
  codes (`EUROPEAN_AIRPORTS` in `check.js`). AF/KL routings will almost always connect via
  CDG/ORY or AMS; Lufthansa/Swiss via FRA or ZRH. A United itinerary that connects through a US
  hub (e.g. ORD-EWR-FCO) will be rejected by this same rule, same as it would be for any other
  carrier — the rule wasn't relaxed when United was added. If a real connection ever gets
  rejected because its airport is missing from the list, add the code there.
- State (`state.json`) tracks the day's request count and every trip ID already emailed, so
  re-running frequently won't spam you or blow through the request budget. Delete `state.json`
  if you ever want to reset and get re-notified about currently-available matches.
