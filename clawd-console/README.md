# Clint Console

Next.js 16 console UI for Clint. This app runs on James's laptop and proxies requests to the bot HTTP API and EVO memory service.

## Development

Install dependencies, then run:

```bash
npm run dev
```

The dev server runs on [http://localhost:3100](http://localhost:3100).

Required environment variables:

- `PI_URL` or `PI_URL_LAN`: bot HTTP API base URL
- `EVO_URL` or `EVO_URL_LAN`: EVO memory-service base URL
- `DASHBOARD_TOKEN`: shared auth token for bot API requests

The browser talks only to the local Next app. Route handlers in `src/app/api/pi/` and `src/app/api/evo/` proxy requests to the real services.

## Main Surfaces

- `/`: overview cards and health
- `/overnight`: structured morning report, event log, and shadow candidates
- `/routing`: routing and trace analysis
- `/memory`: EVO memory browser
- `/logs`: live messages and traces

## Notes

- This repo uses Next.js `16.2.2`.
- The overnight page reads `morning-report` and `overnight-events`, not the retired `overnight-report` JSON endpoint.
