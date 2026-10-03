<div align="center">

# LANtern 🏮

**Expose every model in your local DSH to the LAN.**

**English** · [中文](README.md)

[![platform-web](https://img.shields.io/badge/platform-web-blue)](#installation)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.1.5%20%7C%200.2.0-blue)](#compatible-dsh-versions)

</div>

---

## What it is

Your local DeepSeek Harness already has a set of AI models configured — various providers,
each with its own login state and quota. **Your phone, tablet, or second computer can't use them**,
unless you copy every key onto every device.

LANtern solves exactly that: **it runs a small OpenAI / Anthropic-compatible gateway inside your
local DSH and exposes the models DSH already knows about to your LAN.**

```
┌──────────────┐      ┌───────────────────┐      ┌────────────────┐
│ phone/tablet │ ───► │  LANtern gateway  │ ───► │  provider APIs │
│ 2nd computer │ ◄─── │ (inside local DSH)│ ◄─── │ (existing auth)│
└──────────────┘      └───────────────────┘      └────────────────┘
      your LAN              your machine              upstream
```

It **adds no accounts, changes none of your DSH configuration, and touches no other plugin**:
it reads the model registry DSH already exposes, then forwards requests.

| You might wonder | Answer |
|---|---|
| Do I re-enter every provider key? | **No.** It reuses the providers and login state DSH already has |
| Will it modify my DSH settings? | **No.** All data lives in the plugin's own directory |
| Who on the LAN can use it? | Only devices holding an **API key you issued** |
| How do I name a model? | `<model>@<provider>`, e.g. `deepseek-v4-pro@buddy` (see [below](#how-to-name-a-model-the-most-commonly-missed-step)) |

---

## Quick start

### 1. Install

You need Node.js and `dsh`:

```sh
npm install -g @deepseek-ai/dsh
```

Install the plugin (replace `web` with your profile name — usually `web`):

```sh
dsh plugin --profile web add dsh-lantern
```

### 2. Restart dsh and refresh the page

```sh
dsh --profile web
```

> A newly added bundle is **not** hot-applied to a running process — a **restart is required**.
> After restarting, **refresh the browser page**.
>
> Requires DSH `0.1.5-rc.2` or newer — **both 0.1.5 and 0.2.0 are tested**, see
> "Compatible DSH versions" below.

### 3. Open the settings panel

Gear icon at the bottom of the sidebar → a new **LANtern** entry appears on the left.

### 4. Four steps to a working setup

| Step | Where | What |
|---|---|---|
| ① | Status & Security → Service toggle | Turn the master switch on (off by default) |
| ② | Status & Security → Listeners & ports | Pick `standalone`, bind `0.0.0.0`, any port (e.g. `3081`) |
| ③ | Status & Security → API Keys | Click "Generate key" and **copy the plaintext immediately** (shown once) |
| ④ | Phone / another computer | Call it with the address and key below |

### 5. Call it from another device

Replace `<YOUR_PC_IP>` with your LAN IP (`ipconfig` on Windows) and `<PORT>` with the port from step ②:

```sh
# OpenAI-compatible
curl http://<YOUR_PC_IP>:<PORT>/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model>@<provider>","messages":[{"role":"user","content":"hello"}]}'
```

```sh
# First, see which models are available
curl http://<YOUR_PC_IP>:<PORT>/v1/models \
  -H "Authorization: Bearer <YOUR_KEY>"
```

---

## How to name a model (the most commonly missed step)

LANtern enforces a **fully-qualified name**: `<model>@<provider>`.

```
deepseek-v4-pro@buddy          ✅
deepseek-v4-pro                ❌ a name without @provider always returns 404
```

**Why**: the same model name can come from several providers (different accounts, quotas, or
regional variants). Without the suffix there's no way to know which one you mean, so it's
mandatory. The 404 response **includes the list of available models** — just copy one.

You can see the model list and its suffixes in two places:

- Browser: `GET /v1/models`
- Settings panel: each provider page on the left lists its models' public names

---

## Exposed endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/models` | GET | Model catalog (supports `?provider=<slug>`) |
| `/v1/models/{id}` | GET | Single model detail (capabilities and provenance) |
| `/v1/chat/completions` | POST | **OpenAI-compatible** inference endpoint (streaming / non-streaming) |
| `/v1/messages` | POST | **Anthropic-compatible** endpoint (**off by default**, enable in settings) |
| `/v1/lantern/health` | GET | Health probe (no auth required) |

> The Anthropic-compatible endpoint is off by default. Enable it under
> Settings → LANtern → Status & Security → Protocol channels when you need a client
> such as Claude Code that only speaks the Anthropic protocol.

### Client configuration

| Client | Base URL | Key |
|---|---|---|
| Tools speaking OpenAI protocol | `http://<IP>:<PORT>/v1` | your generated key |
| Tools speaking Anthropic protocol | `http://<IP>:<PORT>` | your generated key (`x-api-key` header) |

The default **key format** is `sk-` followed by 43 base64url characters (same shape as major
vendors). The plaintext is **shown only once** at generation; the server stores only a sha256
and it can never be displayed again — save it on the spot.

---

## What the settings panel does

| Section | Purpose |
|---|---|
| **Service toggle** | Master switch (off by default); when off, all LAN requests are rejected |
| **Listeners & ports** | Add/remove/edit listeners. `standalone` = the plugin opens its own port; `reuse` = share DSH's port |
| **API Keys** | Generate / rename / enable / disable / delete / **rotate** (new key active, old key kept for a grace period) |
| **Limits & concurrency** | Max concurrency, per-key requests/tokens per minute, `max_tokens` cap, and slots reserved for the local machine |
| **Model & source filters** | Denylist (matches are hidden) + allowlist (when non-empty, only these are exposed) |
| **Protocol channels** | Enable the Anthropic-compatible endpoint |
| **Image input** | Whether to accept images (**off by default**; see below) |
| **Usage stats** | Token usage per key and per call type; exportable as an HTML report |
| **Diagnostics** | Export redacted diagnostics; inspect in-flight requests and breaker state |
| **Danger zone** | Reset breaker, factory reset, stop all listeners (each requires confirmation) |

### About `reuse` mode (important)

`reuse` shares the port DSH itself is already listening on. **Its bind address is determined by
DSH's `--host` start-up argument, and this plugin cannot change it.**

DSH listens only on `127.0.0.1` by default, so the **LAN cannot reach it** in that case. To expose
`reuse` to the LAN you must start DSH with `--host 0.0.0.0`.

**If you want the simple path, use `standalone`** — the bind address is fully under the plugin's
control and does not depend on how DSH was started.

The "Bind" column in settings shows the **address actually in effect** (not your configured value)
and marks whether it was inherited from DSH.

---

## Isolation and safety

The design principle is **read-only reuse, write only to its own directory**.

### Write footprint

| Location | Written? | Notes |
|---|---|---|
| `<plugin dir>/data/` | ✅ **the only place** | config, keys, usage ledger, reports |
| `~/.dsh/settings.yaml` | ❌ **never** | registers no settings namespace |
| Other plugin directories | ❌ never touched | |
| Your sessions and history | ❌ never modified | |
| The `llm` registry | 👁 read-only | reads the model list, modifies nothing |

### Uninstall leaves nothing behind

```sh
dsh plugin --profile web remove dsh-lantern
```

The plugin ships its own assembly layer (`cordis.patch.yml`). Uninstalling removes the package
from the profile's `dsh.profile.bundles`, so the assembly layer is no longer loaded —
**no dangling insert line is left behind**. Deleting the plugin directory takes all of `data/`
with it: zero residue.

> Uninstalling also requires a **dsh restart + page refresh**.

### The one effect that cannot be removed

**Shared upstream quota.** LAN requests and your local conversations **draw on the same upstream
account quota**. That is the premise of the value it provides (reusing existing login state), and
it cannot be avoided.

Protections are built in for this (next section), aiming to be "**rather let the LAN be slower
than slow down the local machine**".

---

## Protections: breaker, rate limits, filters

| Mechanism | Behavior |
|---|---|
| **Concurrency gate** | Caps total LAN concurrency; `slots reserved for local` guarantees the local machine always has room |
| **Per-key rate limit** | Requests per minute (rpm) and output tokens per minute (tpm); exceeding returns **429** |
| **Circuit breaker** | After **consecutive upstream rate limits** the LAN channel pauses (during cooldown: immediate 503, **no upstream call**, no quota burned); half-opens automatically afterwards |
| **Model filters** | Denylist hides matches; a non-empty allowlist exposes only those. **Filters apply both to `/v1/models` and to direct calls** (hidden does not mean bypassable) |
| **Capability gate** | Unsupported requests (e.g. an image sent to a non-vision model) are rejected **before reaching upstream**, wasting no quota |

> The breaker triggers **only on rate limits**. Insufficient balance (402) or network timeouts do
> **not** trip it — those are not signs of being flooded.

---

## Image input and its impact (off by default)

Off by default. While off, image requests return 400 immediately with **zero disk writes**.

When enabled, image bytes are **briefly written to local disk** (the plugin's own attachment
directory) and reclaimed by the ledger once the request finishes.

**Why writing to disk is unavoidable**: DSH's attachment service requires an image to be stored
first so a reference can be handed to the model. This plugin cannot bypass that layer.

**Deletion risk and three safeguards**: the ledger only cleans up objects that **this plugin
created and that are no longer referenced**; objects reused from the local machine are
**never deleted**. Two further checks (reference counting + session reference scanning) apply.

**dry-run is the default**: it only logs, never actually deletes. After observing for a while and
confirming correctness, turn dry-run off in the settings panel.

> If you don't need LAN image input, **leave it off** — that is the safer default.

---

## Usage statistics

Counts **only calls that went through this plugin** (your local DSH conversations are excluded).

- By **time**: today / this week / this month / this year
- By **API key**: calls, token breakdown, hit rate per key
- By **call type**: inference / capability test / performance test
- Exportable as a **self-contained single-file HTML** report (no external resources; easy to archive or share)

**Accounting notes** (spelled out because they're easy to misread):

- Input is split into **miss** and **hit** parts, which do not overlap
- `total = miss + hit + cache write + output` (reasoning tokens are already inside output; not double-counted)
- Cache hit rate is `Σhit / Σ(miss + hit)` — **weighted**, not a per-row average
- With no cache data it displays `—` (**not** 0%)

---

## Naming rule: why model names carry `@provider`

In DSH's model registry, `model` and `provider` are two independent dimensions. LANtern joins them
into `<model>@<provider>` as the public name because:

1. **Uniqueness**: the same model name may come from several providers
2. **Readability**: you can see at a glance which account a request will use
3. **Explicitness**: it prevents the silent case of "thinking you used A while actually using B"

Even a sole provider **does not omit the suffix** — a uniform rule never becomes ambiguous when a
new provider appears.

---

## Troubleshooting

### The LAN can't connect

1. **Check the bind address first**: Settings → LANtern → Listeners & ports, look at "Bind"
   - Shows `127.0.0.1` → bound to localhost only; the LAN cannot connect by definition
   - Shows `0.0.0.0` → binding is correct; the problem is the firewall or the network
2. **Check the firewall**: Windows prompts on first listen — allow "Private networks"
3. **Confirm the port**: `standalone` uses the port you entered; `reuse` uses DSH's own port
4. **Are both devices on the same subnet?** (is the phone on the same Wi-Fi?)

### 401

Wrong or missing key. Check the header: OpenAI style uses `Authorization: Bearer <KEY>`,
Anthropic style uses `x-api-key: <KEY>`.

### 404 with an unknown-model message

The model name lacks the `@provider` suffix. The response body **includes the available list** —
copy one from it.

### 429

A rate limit was hit (per-key rpm/tpm) or upstream throttled. For the former, adjust limits in
settings; for the latter, wait out the cooldown.

### 503

Likely the circuit breaker (consecutive upstream rate limits). Settings → Diagnostics shows the
breaker state and remaining cooldown.

### An `error` event appears mid-stream

Upstream failed. LANtern surfaces it as an **in-protocol error frame** rather than disguising it
as a "normally finished, empty answer".

> **Responsibility boundary**: it only surfaces errors DSH itself perceived. A provider's silent
> behavior (for example ignoring a parameter) is forwarded as-is and never fabricated.

---

## Known limitations

1. **Shared upstream quota** — LAN requests and local conversations share quota; a design premise
   that cannot be removed.
2. **Depends on DSH's model registry** — providers DSH hasn't registered are invisible to LANtern too.
3. **A capability declaration is not a gateway allowance** — a model declaring support for a
   capability doesn't guarantee upstream actually works. Use the model page's "Capability test"
   to verify (**real calls, consumes quota**).
4. **Capability and performance tests consume upstream quota** — and test results **never
   auto-rewrite** capability declarations; they are for your reference only. To change a
   declaration, tick the checkbox on the capability row yourself.

---

## Compatible DSH versions

**One and the same codebase supports both DSH 0.1.5 and 0.2.0** — both are tested (see the table below).

| | 0.1.5 | 0.2.0 |
|---|---|---|
| Plugin installs | ✅ | ✅ |
| Boots and forwards requests | ✅ | ✅ |
| LANtern entry in the settings panel | ✅ | ✅ |

**Every API this plugin uses is unchanged between the two**: `ctx.llm.stream` / `listModels` /
`listProviders` / `resolveModelInfo`, `connection.fetch.register`, `ctx.slots.inject` /
`slots.register`, the `createUserMessage`-family factories, and `webServer.register` (its route
fields `path` / `methods` / `requestBody` / `fetch` are identical).

> **About the 0.2.0 slot changes**: since 0.1.7, DSH's slot system **adds** Component Factories
> (`registerFactory` / `renderFactorySlot`, 18 new types) and **removes or changes nothing** in the
> ordinary Slot contract — `SlotScope` (`root` / `session-maybe` / `session`) is character-for-character
> unchanged. This plugin uses ordinary Slots, so **no adaptation was needed**.

### Why the peer range is an interval instead of `^0.1.5-rc.2`

DSH checks at install time whether a plugin's `@deepseek-ai/dsh-llm` peer range matches its own
runtime version, and **refuses to install** when it does not:

```
installation rejected: Plugin dsh-lantern@0.1.x is incompatible with dsh 0.2.0-rc.2:
  peerDependencies {"@deepseek-ai/dsh-llm":"^0.1.5-rc.2"}
```

`^0.1.5-rc.2` admits only `0.1.5.x`, which leaves 0.2.0 users **completely unable to install**. So the
plugin declares:

```json
"@deepseek-ai/dsh-llm": ">=0.1.5-rc.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0"
```

The two explicit prerelease branches cover 0.1.5 and 0.2.x respectively (`<0.3.0-0` stops a future
0.3.0 from being admitted by accident).

---

## Compatibility

| Item | Requirement |
|---|---|
| DSH | **verified on both 0.1.5-rc.2 and 0.2.0-rc.2** |
| Platform | web |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Dependencies | `@deepseek-ai/dsh-llm` (provided by the DSH environment; no manual install) |

---

## License

[MIT](LICENSE)
