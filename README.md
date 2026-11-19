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
| `as_<role>`     | Employee to run a role's questions as, e.g. `as_manager=…`    |

## What it checks

- **Deployment checks**: `/health` (provider, model, auth mode, disabled phases), the widget
  page (and whether its headers block embedding), `/widget-loader.js`, and one chat request.
- **Question suite, by role**: questions are grouped into **Employee**, **Manager** and
  **HR Admin** tabs (defaults in `public/questions.json`). Each role can run as its own employee
  ID ("Run as employee ID"; empty = the target employee), so you can test with a real manager or
  HR account. One click runs a whole role (**Run … questions**) or every role (**Run all roles**);
  ▶ on a row runs one question. Each question can name:
  - `expectIntent`: the intent TIA should route to (a mismatch is a warning),
  - `expectPresentation`: the card it should show (a mismatch is a warning),
  - `expectAuth: "DENY"`: this role must not get the data. If TIA answers anyway, the
    question **fails**. These defaults assume an employee has no team or analytics
    permission and a manager has no company-wide analytics permission; remove the question
    if your tenant grants that.

  Add your own questions with the form (role, optional intent, card and "Should be denied").
  Added, removed and unticked questions are kept in this browser. Removed defaults can be
  restored. Results export as JSON, grouped by role.
- **Chat**: answers show as a conversation in the right-hand panel: the question, TIA's
  answer, intent, authorization, card, latency, any failed expectation, and the raw JSON.
  Click a question in the suite to jump to its answer. You can also type a question in the
  chat as the selected role and save it to that role's suite.
- **Live widget** (tab next to Chat): either the real embed (`widget-loader.js` adds the launcher to this page, as
  on the Tapplent portal) or the widget page in an iframe at widget, phone or tall size.

Leave actions in loader mode call the Tapplent portal API with the portal's session, so they only
work on the portal. Use iframe mode with **Mock leave actions** to walk through applying leave.

## Security

The server makes requests to the TIA URL you enter, so it only allows TIA's paths (`/health`,
`/widget…`, `/widget-loader.js`, `/api/v1/tia/…`) with GET or POST, and listens on localhost by
default. Keep it that way unless the network is trusted.
# tester-project
