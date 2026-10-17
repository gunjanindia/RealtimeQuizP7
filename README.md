# Quiz Night

A single-page, live audience quiz. The presenter shares the QR code or join URL, starts the five-question quiz, and watches player, submitted-answer, and completion counts update live. Players get their score and answer review; the final leaderboard is ranked by score, then completion time.

## Run it

1. Install [Node.js](https://nodejs.org/) (18 or newer).
2. From this folder, run `npm install` and then `npm start`.
3. Open the presenter dashboard using the public domain configured for your server. The audience URL and QR code use that same host automatically.
4. If the app is behind a reverse proxy, preserve the original `Host` header and set `X-Forwarded-Proto` to `http` or `https`. Alternatively, explicitly set `QUIZ_PUBLIC_URL` to the audience URL, for example `https://quiz.example.com/?join=1`.
5. Sign in through **Admin** on the dashboard to change the audience URL. Locally, the setting is saved in `quiz-config.json`; on Vercel, it is saved in Redis. The URL updates both the QR code and copied join link.

`http://localhost:3000` is useful for local development, but it is only reachable from the server itself. Configure a public hostname (and HTTPS for a public deployment) before sharing the QR code with an audience.

Admin-only actions (starting/ending the quiz and changing the audience URL) are verified by the server. If `QUIZ_ADMIN_PASSWORD` is set before startup, that value is the passcode; otherwise, the app generates one and prints it in the server console. For example, in PowerShell:

```powershell
$env:QUIZ_ADMIN_PASSWORD = "use-a-strong-private-passcode"
npm start
```

The admin dashboard has separate **Start quiz**, **Wrap quiz**, and **Reset quiz** controls. Wrapping asks for confirmation, stops answer submissions, and downloads an admin-only CSV scoresheet in leaderboard order, with each participant's answers and correctness by question, score, and total completion time. Participants who did not finish are included after the ranked finishers with their partial score and unanswered questions indicated. Reset also asks for confirmation, clears the current players, answers, and leaderboard, then returns the quiz to the lobby so another round can begin.

Locally, admin sessions, participants, and answers are held in memory and reset when the server restarts. On Vercel, these are stored in Redis and shared by function instances. This starter app is designed for one active quiz room at a time.

## Deploy to Vercel

This project supports Vercel's Node.js serverless functions and serves the files in `public/` as the static app. Vercel function instances do not share memory, so a Redis database is required to share participant, quiz, and admin-session state. The app uses Upstash Redis through the Vercel Marketplace integration.

1. Push the project to a Git provider and import it into Vercel. Use the project root as the root directory; no build command is needed.
2. Add an Upstash Redis database from the Vercel Marketplace and connect it to this Vercel project.
3. In **Project Settings → Environment Variables**, configure:
   - `QUIZ_PUBLIC_URL` — the full audience URL, such as `https://your-project.vercel.app/?join=1`.
   - `QUIZ_ADMIN_PASSWORD` — a strong, private passcode for the Admin sign-in.
   - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — the REST URL and token provided by the Upstash database. The app also recognizes `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
4. Add the variables to the Production environment (and Preview if needed), then redeploy. Never commit actual passwords or Redis tokens; `.env.example` contains placeholders only.
5. Open the deployed URL, sign in with `QUIZ_ADMIN_PASSWORD`, and verify the QR code points to the deployed audience URL.

The quiz state is shared between serverless function invocations using Redis. It remains available across deployments until the quiz is reset; use a dedicated Redis database for this app because its state keys are shared by deployments using the same database. If you configure Preview deployments, give them a separate Redis database so preview testing cannot modify the production room. Vercel and Upstash free-plan limits and availability can change, so check their current plan quotas before an event.
