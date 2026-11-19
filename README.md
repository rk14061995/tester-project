# TIA Tester

A small standalone app for checking a TIA deployment by its URL. No dependencies, no build.

## Run

```bash
node server.mjs            # Node 22+; opens on http://127.0.0.1:4300
PORT=5000 node server.mjs  # another port
HOST=0.0.0.0 node server.mjs  # reachable from other machines (see Security)
```

Open the page, enter the **TIA URL** (e.g. `https://localhost` or a deployed host) and an
**employee ID**, then **Apply and run checks**.

Settings are kept in the page URL, so a run can be shared:

```
http://127.0.0.1:4300/?url=https://localhost&employee_id=7DCC838C11ED52F1A84206AC6BC4B408&mode=iframe&mock=1
```

| Parameter       | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `url`           | TIA base URL (serves `/widget`, `/widget-loader.js`)          |
| `employee_id`   | Employee the widget and API act as                            |
| `employee_name` | Name for the widget greeting (optional)                       |
| `api_base`      | Separate API host, if the API isn't at `url` (optional)       |
| `mode`          | `loader` (embed with widget-loader.js) or `iframe`            |
| `mock`          | `1` = mock leave actions in iframe mode (nothing is applied)  |
| `insecure`      | `0` = reject self-signed certificates (default accepts them)  |

## What it checks

- **Deployment checks**: `/health` (provider, model, auth mode, disabled phases), the widget
  page (and whether its headers block embedding), `/widget-loader.js`, and one chat request.
- **Question suite**: sends each question to `/api/v1/tia/chat` and shows the answer, intent,
  agent, authorization, card type and latency, with the raw JSON. A question can name the card
  type it expects (`summary_card`, `org_chart`…); a different card is flagged. Questions can be
  added or removed (kept in the browser), run in one shared conversation, and exported as JSON.
  The defaults are in `public/questions.json`.
- **Live widget**: either the real embed (`widget-loader.js` adds the launcher to this page, as
  on the Tapplent portal) or the widget page in an iframe at widget, phone or tall size.

Leave actions in loader mode call the Tapplent portal API with the portal's session, so they only
work on the portal. Use iframe mode with **Mock leave actions** to walk through applying leave.

## Security

The server makes requests to the TIA URL you enter, so it only allows TIA's paths (`/health`,
`/widget…`, `/widget-loader.js`, `/api/v1/tia/…`) with GET or POST, and listens on localhost by
default. Keep it that way unless the network is trusted.
