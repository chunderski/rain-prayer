# Running the Sentinel Assess demo

This guide gets the full product running on your own laptop with a ready-made customer story, so you can show it to a prospect. Plan on 15 minutes the first time (mostly downloads); after that it starts in seconds.

## What you get

A believable integrator account, **Acme Integrators**, working for a customer, **Harbor Logistics**:

- **North terminal**: a finished assessment across all five frameworks, with three findings and photos, risk scores, an approved executive summary, a branded report, and a Good, Better, Best quote already sent to the customer.
- **South yard**: the same kind of site in worse shape, still in progress. It works well for side-by-side comparison.
- **Dana Ortiz**: Harbor's own login, so you can show what the customer sees.

The demo data is illustrative. The answers, risk inputs, and price book are placeholders, not a real assessment.

## One-time setup

You need two free programs. Install each with its normal installer:

1. **Node.js 22 or newer** (the "LTS" version): https://nodejs.org
2. **Docker Desktop**: https://www.docker.com/products/docker-desktop. After installing, open it once and wait until it says Docker is running. The demo keeps its database in Docker so nothing else on your laptop is touched.

Then get the code. In a terminal (Mac: the Terminal app; Windows: PowerShell):

```bash
git clone https://github.com/chunderski/rain-prayer.git
cd rain-prayer
git checkout claude/sentinel-assess-kickoff-5g3n44
```

(Once this branch is merged, the `git checkout` line is no longer needed.)

## Start the demo

Make sure Docker Desktop is open, then in the `rain-prayer` folder run:

```bash
npm run demo
```

The first run installs packages, downloads the database, builds the app, and loads the story. When it is ready, your browser opens to **http://localhost:8080** and the terminal shows:

```
✔ Sentinel Assess demo is running

  Open:  http://localhost:8080

  Integrator (owner)     owner@acme.test         Sentinel-dev-2026!
  Field assessor         assessor@acme.test      Sentinel-dev-2026!
  Customer (client view) dana@harbor.example     Harbor-client-2026!
```

Leave that terminal window open while you present.

## Stop, restart, reset

| To | Do this |
|---|---|
| Stop | Press **Ctrl+C** in the terminal. Your demo data is kept. |
| Start again | `npm run demo` (about 10 seconds) |
| Start fresh, for example after a customer clicked Accept | `npm run demo:reset` |

Tip: run `npm run demo:reset` the morning of each customer meeting so everything is in its starting state.

## A 10-minute walkthrough

Sign in as **owner@acme.test**. If the app offers to set a PIN, choose **Not now**.

1. **Dashboard** (Home). Assessments by status, open findings by severity, and the top remaining risks across every site. *"This is the integrator's morning view across all customers."*
2. **One walkthrough, every framework.** Open **South yard**. Point at *Controls to check 101, Questions 184, counted once even when a control serves several frameworks*. *"One site walk covers physical security, CPTED, CARVER, NIST CSF 2.0, and post-quantum readiness; the assessor never answers the same question twice."* Tap **Start walkthrough** to show the guided, area-by-area questions.
3. **Findings and photos.** Open **Findings** and **Photos**: each finding has its photo, severity, and the controls it affects. *"Assessors capture this on a phone, even with no signal; it syncs when they are back online."*
4. **Risk results.** Go back, open **North terminal**, then **Risk results**. Each threat scenario shows inherent risk, the effect of the controls in place, and residual risk, with a plain-English explanation of the score.
5. **Compare sites.** From the dashboard, **Compare sites**, tick both assessments, then **Compare 2 assessments**. *"Same customer, two sites, side by side: this is how you prioritize the budget."*
6. **The report.** On North terminal, open **Report and export**. The preview carries Acme's logo, colors, and footer, not ours. *"Your brand on every report."*
7. **Findings to quote.** Open **Quotes** on North terminal: the quote was built from the findings and the price book, in Good, Better, Best options, with margin checks and owner approval before it goes out.
8. **The customer's view.** Sign out and sign in as **dana@harbor.example**. Dana sees only her company's finished assessment and the proposal, with prices and no internal costs or margins. Open the proposal, choose an option (Better is a good one to show), type Dana's name, and click **Accept proposal**.
9. **Close the loop.** Sign back in as the owner and open **Portfolio** from the dashboard: the accepted quote value now shows against North terminal.

Settings worth showing if asked: **Settings, Branding** (colors are checked for readability), **Members** (invite staff and customer logins), and **Price book**.

## Showing it to a customer who is not in the room

- **Video call:** share your screen. This is the simplest and most reliable option.
- **A phone or tablet in the room:** the terminal prints a second address, for example `http://192.168.1.20:8080`, for devices on the same Wi-Fi. Test it before the meeting; some office networks block it. Offline mode and "add to home screen" need the laptop's own `localhost` address or a secure (https) address, so show those on the laptop.

## Optional: live AI photo analysis

The demo runs without AI keys; everything above works without them. To show Claude analyzing a photo, start the demo with your Anthropic key:

```bash
ANTHROPIC_API_KEY=your-key npm run demo          # Mac or Linux
$env:ANTHROPIC_API_KEY="your-key"; npm run demo  # Windows PowerShell
```

This has not yet been tested against the live Anthropic service, so try it privately before using it in front of a customer. Google Docs export also needs Google credentials and is not part of this demo.

## If something goes wrong

| Message | Fix |
|---|---|
| *Docker is not running* | Open Docker Desktop, wait until it says it is running, try again. |
| *Node.js 22 or newer is needed* | Install the LTS version from nodejs.org, open a new terminal, try again. |
| *port 8080 ... busy* | Something else uses that port. Run `DEMO_PORT=8090 npm run demo` (PowerShell: `$env:DEMO_PORT=8090; npm run demo`) and open http://localhost:8090. |
| *The demo database belongs to an earlier setup* | Run `npm run demo:reset`. |
| *The api stopped unexpectedly* | The message names a log file in the `.demo` folder; send it to engineering. Then try `npm run demo:reset`. |
| Anything else | `npm run demo:reset` fixes most problems. |

## Before a real customer engagement

This is a demo build. Before customers use it with real data, the open items in `PLAN.md` apply: email verification for sign-up, live testing of the AI and Google connections, expert review of the framework wording and risk weights, and a real price book.

## For engineers

`npm run demo` is `scripts/demo/run-demo.mjs`. It runs Postgres 16 in a Docker container named `sentinel-demo-db` (port 55432, data in the `sentinel-demo-db` volume), migrates and seeds a `sentinel_demo` database, builds the PWA for `http://localhost:8080/api`, starts the API on port 3100, loads `scripts/demo/seed-story.mjs` through the real API, and serves everything from one address with `scripts/demo-server.mjs`. Secrets are generated per machine in `.demo/` (git ignored). To use an existing Postgres 16 instead of Docker, set `DEMO_ADMIN_DATABASE_URL` to a superuser connection string; it creates the `sentinel_owner` and `sentinel_app` roles (resetting their passwords) and a `sentinel_demo` database.
