<img src="assets/wireframe-mesh.svg" alt="Abstract dark wireframe mesh: glowing connected nodes over a perspective grid" width="100%" />

# Susu Protocol — Web Client

[![CI](https://github.com/susu-labs/susu-web/actions/workflows/ci.yml/badge.svg)](https://github.com/susu-labs/susu-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status: Testnet · reviewed](https://img.shields.io/badge/status-testnet%20%C2%B7%20reviewed-orange.svg)](#project-status)
[![Mainnet: readiness implemented · deployment gated](https://img.shields.io/badge/mainnet-readiness%20implemented%20%C2%B7%20deployment%20gated-yellow.svg)](#project-status)

The web client for **Susu Protocol** — a non-custodial rotating savings protocol on Stellar.

It is a client in the strict sense: it builds transactions, asks a wallet to sign them, submits
them, and then reports what the chain actually did. **It cannot move money.**

> **Reviewed by the maintainer, and not independently audited.** It talks to Stellar Testnet,
> where the balances are worthless. Mainnet readiness is implemented and mechanically verified, but
> deployment is deliberately gated until the attestations are satisfied. Read
> [Project status](#project-status) before you read anything else.

---

## The system

Susu is four repositories. This one is what a member sees.

| Repository | Responsibility | Runs on |
| --- | --- | --- |
| [`susu-contracts`](https://github.com/susu-labs/susu-contracts) | Soroban contracts. The financial authority. | **Testnet** |
| [`susu-indexer`](https://github.com/susu-labs/susu-indexer) | Reads chain events, records them in Postgres on a schedule. | **Testnet** (Supabase Cron) |
| [`susu-api`](https://github.com/susu-labs/susu-api) | Read model, accounts, invites, notifications, transaction preparation. | Local |
| **`susu-web`** *(you are here)* | The client. | Local |

Closing this repository changes nothing about anyone's money. That is a property of the design,
not of good intentions.

## Project status

**Testnet. Reviewed by the maintainer. Mainnet readiness implemented — deployment gated on attestations.**

All twelve planned build phases are implemented: accounts and sessions, the Soroban RPC client,
the chain-result layer, the Freighter wallet adapter, the typed Factory/Group contract clients,
the create / join / start / contribute / payout screens, the group and activity dashboards,
settings, and the public landing page. The flow has been exercised end-to-end against the
deployed Testnet contracts.

This client is **not hosted anywhere** — there is no deployment configuration in this repository.
The contracts and the indexer are the parts that are live; this is run locally against them.

Two gates stand between this and Mainnet. The machinery for both is written; neither is satisfied:

| Gate | State |
| --- | --- |
| **Independent security review** | **Not commissioned. The maintainer has reviewed this code, which is a different claim.** What a reviewer needs is in [`susu-contracts/docs/AUDIT_SCOPE.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/AUDIT_SCOPE.md), and the code to review is frozen at the annotated `audit-freeze-1` tag. |
| **Mainnet readiness** | **Implemented and mechanically verified; `NO-GO` until the attestations are satisfied.** See [`susu-contracts/docs/MAINNET_READINESS.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/MAINNET_READINESS.md). |

Writes to Mainnet are refused in code, and the app will not start configured for Mainnet without
an explicit acknowledgement — see `src/lib/stellar/network.ts`.

## Contents

- [What Susu is](#what-susu-is)
- [This app is not a custodian](#this-app-is-not-a-custodian)
- [Chain access and wallets](#chain-access-and-wallets)
- [Accounts and sessions](#accounts-and-sessions)
- [Stack](#stack)
- [Motion](#motion)
- [Routes](#routes)
- [Development](#development)
- [Checks](#checks)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What Susu is

Members of a group contribute a fixed amount at a fixed interval. Once every member has
contributed for the current round, the pool is paid to the scheduled recipient, minus a
transparent **0.50% (50 bps)** protocol fee. Rounds continue until every member has
received exactly one payout.

## This app is not a custodian

The frontend **cannot** move money, decide balances, choose a payout recipient, or
authorize a financial action. It builds transactions, simulates them, asks the wallet to
sign, submits them, and then reports what the chain actually did. A successful wallet
signature is never treated as success — only chain confirmation is.

## Chain access and wallets

| Module | Responsibility |
| --- | --- |
| `src/lib/stellar/network.ts` | Derives the network, RPC URL and passphrase from validated config. Refuses an RPC endpoint that contradicts the configured network, and refuses mainnet writes. |
| `src/lib/stellar/client.ts` | Lazily constructed Soroban RPC server and contract handles for the Factory and the USDC SAC. |
| `src/lib/stellar/result.ts` | Interprets what the chain actually said. Owns the rule that a submission is not a result. |
| `src/lib/stellar/submit.ts` | The single path a signed transaction takes to the network. |
| `src/lib/stellar/contracts/` | Typed Factory and Group clients, plus strict decoders for raw contract output. |
| `src/lib/stellar/invoke.ts` | The single pipeline every contract call takes: build → simulate → assemble → sign → submit → confirm. A call that fails simulation never reaches the wallet. |
| `src/lib/susu/` | USDC amounts as exact integer stroops, and the React Query hooks that read and mutate group state. |
| `src/lib/wallet/` | Wallet interface, registry, and the Freighter adapter (MVP). |

### Why raw contract output is decoded defensively

Contract reads arrive as loosely-typed native values, so every field is validated before it
reaches the UI. A `#[contracttype]` unit enum, for example, decodes to `["Active"]` — a
single-element array, not `"Active"`. That shape was confirmed by reading the deployed
Testnet contract rather than assumed; an earlier decoder that required a bare string passed
against its own fixtures and failed against every real group.

Amounts are carried as `bigint` stroops end to end and never converted to floating point,
and the local fee preview reuses the contract's own integer split so the two cannot disagree.

### Why the result layer exists

A wallet signature proves only that a user authorized something, and a node accepting a
transaction proves only that the envelope reached its mempool. Neither means money moved.
So the app distinguishes four outcomes, and never collapses them:

- `confirmed` — the ledger reports `SUCCESS`. The only success.
- `failed` — the ledger reports `FAILED`. The transaction was applied and rejected.
- `unknown` — the network never reported it within the polling budget. Presented as
  unknown, never as success or failure.
- `retry` / `rejected` — the node declined to accept it.

`DUPLICATE` on submission is treated the same as `PENDING`, because it usually means an
earlier attempt is already being applied, not that the request failed.

The Freighter adapter also rejects two responses that would otherwise look like
signatures: an envelope returned unchanged, and a signature produced by a different
account than the one requested (which usually means the active account was switched).

### The wallet is not trusted to return what it was given

A wallet sees the transaction it is asked to sign, and hands back a signed envelope. Nothing
in the protocol forces those to be the same transaction, and a compromised or malicious wallet
could return a signature over something else entirely.

So after signing, `invoke.ts` compares the bytes each transaction authorizes —
`signatureBase()` on both — and refuses to submit if they differ, reporting what changed:
a destination, a different amount, a different operation. Nothing reaches the network.

This is a check against a compromised wallet, not against a compromised page. A page running
attacker-controlled JavaScript can do whatever it likes regardless; the point is that the
*wallet* is not given the benefit of the doubt. What is still missing is an in-app transaction
preview, so today the wallet remains the only place a member can see what they are about to
authorize. That is recorded as a known weakness rather than papered over.

## Accounts and sessions

Credentials are handled entirely by Supabase Auth. This app never sees or stores a
password, and no password is ever written to a table it owns.

| Module | Responsibility |
| --- | --- |
| `src/lib/auth/actions.ts` | Signup, sign-in, sign-out, password reset and confirmation resend. Every one returns a result rather than throwing, so no page can leave a button apparently doing nothing. |
| `src/lib/auth/errors.ts` | Translates provider failures into codes the UI branches on, and reads the failures the provider reports in the URL rather than in a response. |
| `src/lib/auth/validation.ts` | Field-level feedback. Not a security control — Supabase's project settings are the authority and re-check every rule. |
| `src/lib/auth/context.ts`, `src/components/AuthProvider.tsx` | The session, and the observation of it. |
| `src/routes/RequireAuth.tsx` | Gates `/app/*` behind a session. |

### An account and a wallet are separate

Being signed in never implies being able to move funds. An account can exist with no
wallet linked, and a wallet can be connected with no account — which is exactly what an
invite link needs, so the wallet provider is mounted outside the authenticated shell. The
two controls in the app header are deliberately separate, because signing out does not
disconnect the wallet and disconnecting the wallet does not sign anyone out.

`RequireAuth` is a routing convenience, not a security boundary. It decides which
interface to show; everything behind it is already protected by row-level security on the
database and by the chain.

### Choices worth knowing about

**Failures are shown from a code, not from the provider's text.** Provider prose is
unstable and can name internal detail, and several distinct causes share similar wording.
Translating once means the right remedy appears — `email-not-confirmed` offers to resend
the confirmation instead of repeating the problem.

**Login does not reveal whether an address is registered.** A wrong password and an
unknown address produce one message between them. "No such user" would turn the login
form into a way for anyone to test which addresses have accounts, and the addresses here
belong to people handling money together. Signup is the same: Supabase answers an existing
address with a success-shaped response, and the screen shows the same confirmation panel
either way.

**Password reset ends other sessions.** A password is usually reset because the user
believes someone else has access. Changing it does not by itself remove that access — the
other party holds a refresh token that stays valid — so every other session is revoked
once the new password is set.

**Reset links that have expired are recognised as such.** The provider reports that in the
URL fragment rather than through an API failure, so without `authErrorFromUrl` the page
would wait forever for a session that is never coming.

### Required Supabase configuration

Both redirect URLs must be listed in the project's redirect allowlist
(Authentication → URL Configuration → Redirect URLs), or Supabase silently substitutes the
Site URL and the emailed links land somewhere unexpected:

- `{VITE_APP_URL}/app` — where a confirmed signup lands
- `{VITE_APP_URL}/reset-password` — where a recovery link lands

Email confirmation must also be enabled for the signup flow to ask for confirmation.

## Stack

React · Vite · TypeScript · Tailwind CSS v4 · Framer Motion · TanStack Query · React Router · Zod · Stellar SDK · Freighter

## Motion

Animation marks arrival and nothing else: a section entering view, a list filling in, a page
replacing another. No state is *reported* by movement — a pending transaction, a waiting round
or an unknown outcome is still stated in words, because a screen reader cannot announce a slide,
and a member deciding whether their money moved should never have to infer it from one.

Everything lives in `src/components/motion.tsx`. Two rules matter before adding to it:

- **Use `m`, never `motion`.** The app is mounted inside `LazyMotion` with the `domAnimation`
  feature set, so only the animation features this project uses are shipped. `motion.div`
  bypasses that and pulls in all of Framer Motion — layout projection, drag, the lot. It costs
  about 28 kB gzipped, on a bundle that is already large, to animate a fade.
- **Reduced motion is honoured twice.** `MotionConfig reducedMotion="user"` makes Framer Motion
  itself drop transforms, and every component also checks `useReducedMotion` and renders its
  children plainly with no initial state at all. The second check is what covers the fade, since
  a fade is motion too and would otherwise still start invisible. `index.css` neutralises CSS
  transitions for the same reader, because those are declared in a different place.

Animated blocks carry `data-reveal`, and `index.html` ships a `<noscript>` rule that un-hides
them: an element that begins at `opacity: 0` and is animated by script is invisible when the
script never runs, and a blank page is a worse failure than no animation at all.
`src/components/motion.test.tsx` asserts that coupling, so the attribute and the rule cannot be
renamed apart.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing |
| `/login`, `/signup` | Authentication |
| `/forgot-password`, `/reset-password` | Password recovery |
| `/join/:inviteCode` | Join via invite |
| `/app` | Overview |
| `/app/groups` | Group list |
| `/app/groups/create` | Create a group |
| `/app/groups/:id` | Group detail |
| `/app/activity` | Activity |
| `/app/settings` | Settings |
| `/app/transactions/:hash` | Transaction detail |

Everything under `/app` requires a session and redirects to `/login` without one. The
attempted destination is preserved, so signing in returns the user to where they were
going rather than to the overview.

## Development

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env    # then fill in values
pnpm dev
```

## Checks

CI runs all of these, in this order, and a failure at any step stops the run:

```bash
pnpm audit --audit-level high
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### API response size

The HTTP client accepts at most **1 MiB (1,048,576 bytes)** per response body,
including error responses. It counts the bytes delivered by the browser's response
stream, after HTTP content decoding, rather than trusting `Content-Length` or
counting JavaScript characters. A body exactly at the limit is accepted.

On overflow, the client cancels the reader and throws an `ApiError` with code
`response_too_large`; this error is not automatically retryable. Empty responses,
normal JSON, non-JSON HTTP errors, and request cancellation keep their existing
behavior. The limit applies to all three API request helpers.

## Configuration

All configuration is browser-visible. **Only the Supabase publishable/anon key may appear in
frontend environment variables.** `src/lib/env.ts` validates configuration at runtime and
refuses to start if it detects a service-role key, secret key, database URL, or other
server-side credential — including an `anon` variable that actually contains a
`service_role` token.

## Deployment

This is a static single-page app, which means the host has to be told that every URL it does not have
a file for belongs to the router. Get that wrong and the site works until the first refresh, when it
returns the host's 404 instead of the app.

- [`docs/DEPLOY_VERCEL.md`](docs/DEPLOY_VERCEL.md) — Vercel, via [`vercel.json`](vercel.json).
- [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md) — Render, via [`render.yaml`](render.yaml).

Both files configure the same thing — a catch-all rewrite to `index.html`, plus the security headers
`docker/security-headers.conf` sets for the container path — so all three deployments serve one
directory of files the same way.

One caveat that applies to every host here: `VITE_` variables are compiled into the bundle at build
time, so changing one requires a redeploy rather than a restart, and only browser-safe values may
appear there at all.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Anything that changes how money appears, what a user is asked to sign, or what is reported as
confirmed needs maintainer review first. Open an issue before a pull request.

## Security

This app has been reviewed by the maintainer, not by an independent auditor. See
[`SECURITY.md`](SECURITY.md) for reporting. Never place credentials in this repository, and never
commit a populated `.env`.

CI runs `pnpm audit --audit-level high` before lint and test, so a known-vulnerable
dependency fails the build rather than being discovered later. The threshold is high and
critical — the severities with a real exploit path — because failing every push on a moderate
advisory in a build-time tool is how a gate becomes something people re-run without reading.
The gate can go red without anyone changing this repository, since the advisory database is
amended continuously; that is intended, and the next push is held until somebody looks.

Dependabot raises the updating pull requests, grouped so a week of patch bumps is one review
while a major bump stands on its own. It runs weekly; neither mechanism substitutes for the
other, since the audit reports and only a version change fixes.

## License

[MIT](LICENSE)
