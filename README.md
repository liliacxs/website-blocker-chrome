# FocusGuard

Chrome (Manifest V3) extension that restricts chosen websites via schedules, one shared daily
allowance, focus sessions and cooldown-protected settings. Local-first: no backend, no accounts,
no network requests. Plain JavaScript ES modules, no build step.

## Run it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's settings, add a website, and try visiting it.

## Test

```
npm test          # core logic, TZ=Europe/London
npm run test:dst  # same suite, TZ=America/New_York
```

## Layout

| Path | Role |
| --- | --- |
| `src/lib/engine.js` | Restriction engine: single source of truth for blocked / why / until when |
| `src/lib/schedule.js` | Schedule windows, overnight handling, next start/end |
| `src/lib/usage.js` | Usage segments, checkpoint recovery, midnight rollover, clock-skew safety |
| `src/lib/changes.js` | Cooldown manager (pending changes) and focus manager |
| `src/lib/domain.js` | Normalisation, validation, subdomain matching |
| `src/background.js` | Service worker: one `reconcile()` pipeline driven by Chrome events and alarms |
| `src/pages/` | Popup, settings/statistics, blocking page |

Everything in `src/lib/` except `storage.js` is pure and unit-tested; the worker keeps no in-memory state.

## Design decisions worth knowing

- **Stricter changes are immediate, looser ones wait.** This includes *adding* a site (the PRD lists it as
  protected, but also says stricter changes can be immediate; adding is stricter). Schedule edits are judged by
  comparing blocked minutes across the week before and after.
- **Downtime is never counted.** Usage is checkpointed every 30 s; a segment older than 90 s is treated as
  unverified and credited as zero.
- **Clock changes can't refund time.** The usage date only moves forward and negative elapsed time is ignored.
  Cooldowns use the wall clock, so moving the clock forward can shorten one.
- **Host permissions are `http(s)://*/*`.** DNR *redirect* rules need host access, and the restricted list is
  dynamic, so it can't be scoped statically. The extension never reads page content.
- **`windows` needs no permission** in Chrome; `notifications` is omitted (usage notifications are Phase 2).
- A browser extension cannot prevent uninstalling, disabling, another profile or another browser.
