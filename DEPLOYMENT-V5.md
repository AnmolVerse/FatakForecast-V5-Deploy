# FatakForecast V5 Deployment Notes

## Runtime

- Node.js backend starts with `npm start` from `backend/`.
- The backend serves the static frontend from the repository `frontend/` directory.
- Set `RAILRADAR_API_KEY` in the hosting provider's environment/secrets panel.
- Do not upload `backend/.env` to the host or repository.

## Required production environment

```text
RAILRADAR_API_KEY=<your rotated RailRadar key>
PORT=<provider supplied port, if applicable>
```

## Prediction pipeline

```text
RailRadar live train telemetry
        ↓
ETA / crossing passage prediction
        ↓
11-minute closure prior + 1-minute reopen prior
        ↓
Verified manual gate observations
        ↓
Crossing/direction adaptive correction
        ↓
Chronological ML evaluation
        ↓
ML prediction only if it beats the 11-minute baseline
```

## Ground-truth endpoint

`POST /api/observations`

Required:
- `crossingId`
- `gateCloseTime`
- `trainPassageTime`

Useful:
- `gateOpenTime`
- `trainNumber`
- `direction`
- `feedback`
- `notes`

The backend validates timestamps, prevents obvious duplicate submissions, attempts event matching, and exposes dataset/model status in the response.

## Important data rule

Never train on FatakForecast's own predicted `11-minute` values. They are the baseline being evaluated. Only verified actual gate observations are valid labels.

## Hosting architecture

FatakForecast uses on-demand RailRadar fetching. No RailRadar requests are made while the application has no active users. When the application is open, the frontend requests forecasts through the backend using quota-aware caching and adaptive refresh intervals.

The architecture is fully compatible with free/sleeping hosting platforms (e.g., Render, Koyeb) and does not require a permanently running background collector loop.

Persistent production storage should eventually move from JSON files to PostgreSQL or another durable database. The current JSON storage is suitable for the initial observation-collection phase, but not for a large long-term dataset.
