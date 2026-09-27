# FatakForecast V4 — Critical Fixes

## Core correction
All train/crossing approach arithmetic now uses the **same GeoJSON railway coordinate system**.

- Train position: current RailRadar sequence + segmentProgress -> project station positions onto route GeoJSON -> interpolate by track distance.
- Crossing position: project crossing coordinates onto the same route GeoJSON.
- Station-anchor ETA: station positions are also converted to the same GeoJSON coordinate system.
- RailRadar route `distance` values are retained only as diagnostics/timing metadata and are never mixed with GeoJSON `locationKm`.

## Direction correction
When observation history is insufficient, direction fallback uses route **sequence**, not incompatible distance scales.

## Data integrity
Active prediction datasets were reset because previous observations/events were generated under older coordinate logic. They remain archived under `backend/data/legacy-v1-v3/` and are not consumed by V4.

## Safety
- Stale live positions cannot produce live-position ETAs.
- A train coordinate more than 0.5 km from the supplied route is rejected.
- Missing route geometry/sequence does not produce a fabricated position.
- Only the four configured V1 crossings are retained.

## API/rate-limit behavior
Route geometry is cached. RailRadar 429 responses use bounded retry/backoff. No API key is bundled with the release.


## V5 engineering pass

- Standardized the central closure timeline to an 11-minute initial closure baseline and 1-minute reopening baseline.
- Added ground-truth observation submission endpoint and duplicate-observation protection.
- Added gradual crossing/direction adaptive correction from verified observations.
- Added chronological held-out ridge-regression evaluation against the 11-minute baseline.
- ML is gated off until sufficient verified data exists and the test set demonstrates improvement.
- Added frontend actual-timing feedback collection.
- Switched frontend API origin to the current origin by default instead of hard-coding Render.
