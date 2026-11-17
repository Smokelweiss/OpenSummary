# OpenSummary

[![English](https://img.shields.io/badge/English-1f6feb?style=for-the-badge)](README.md)
[![Русский](https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-6e7781?style=for-the-badge)](README.ru.md)
[![Українська](https://img.shields.io/badge/%D0%A3%D0%BA%D1%80%D0%B0%D1%97%D0%BD%D1%81%D1%8C%D0%BA%D0%B0-6e7781?style=for-the-badge)](README.uk.md)

Browser extension that builds a **summary of any YouTube video** with just about any AI provider (OpenAI-compatible APIs, Google Gemini, Anthropic, local models through Ollama / LM Studio).

```
┌──────────────┐   captions    ┌──────────────────┐   summary   ┌──────────────┐
│   YouTube    │ ────────────▶ │   AI provider    │ ──────────▶ │  in-page     │
│   (page)     │               │   (your choice)  │             │  panel       │
└──────────────┘               └──────────────────┘             └──────────────┘
```

* **One engine — AI.** The summary is written by the model you choose; there is no non-AI summarizer — its output was a pile of repeats and fragments, so the engine was removed. The strategy is adaptive: if the whole transcript fits the safe context budget (128 000 tokens by default), it is **one request** — even for a three-hour video (~64 000 tokens). Inside that single answer the TL;DR, key moments and sections appear in the panel as they are generated — as soon as the model closes a value and it passes validation, not after the last brace. If the transcript does not fit, a parallel map-reduce takes over with large chunks (6 000 tokens): finished chunks appear in the panel as answers arrive, and the final TL;DR is assembled only after the whole transcript is processed, without losing timecodes and with an explicit note when some part failed. Streaming, cancellation, retries, automatic failover to a backup provider, summary cache and chunk-analysis cache are all there. If Chrome/Firefox unloads the background process mid-run, the panel offers a **Continue** button and resumes exactly the saved job from the chunks that were already finished — provided the transcript, prompt, model and settings have not changed.

## Features

| Section | What is inside |
| --- | --- |
| **Overview** | TL;DR, sections by topic or by chapters (the whole heading is a link to that moment in the video), key moments and takeaways with timecodes, conclusions, action items, quotes |
| **Q&A** | Questions about the content: the model answers with cited sources. With no provider configured, a fallback BM25 transcript search quotes the matching fragments instead of paraphrasing them |

Keywords, entities, stats, number checks and run diagnostics live under the collapsed **Run details** at the bottom of the panel — they explain how the summary was produced, not the summary itself.

Also included: a round button on the watch page, a popup with quick actions, a settings page, export to Markdown / TXT / JSON (optionally together with the transcript), summary cache and history, keyboard shortcuts, and a context menu on video links.

## Supported AI providers

Four API families cover almost everything:

| API type | Examples |
| --- | --- |
| OpenAI-compatible `/chat/completions` | OpenRouter, Groq, Cerebras, Mistral, DeepSeek, Together, Fireworks, DeepInfra, Novita, SambaNova, NVIDIA NIM, GitHub Models, Cloudflare Workers AI, Qwen (DashScope), Zhipu GLM, Moonshot, SiliconFlow, Chutes, Hyperbolic, ArliAI, xAI, LM Studio, llama.cpp, vLLM, Jan, text-generation-webui |
| Google Gemini | `generativelanguage.googleapis.com` (AI Studio) |
| Anthropic Messages | `api.anthropic.com` (`x-api-key` header + browser access) |
| Ollama | `localhost:11434` (`/api/chat`, `/api/tags`) |

Settings ship with ready-made presets marked "free tier": **Google AI Studio**, **Groq**, **Cerebras**, **OpenRouter (`:free` models)**, **Zhipu GLM-4-Flash**, **GitHub Models**, **SambaNova**, **Together**, **Cloudflare Workers AI**, **NVIDIA NIM**, **Qwen**, **SiliconFlow**, **Chutes**, **Hyperbolic**, **ArliAI** and local engines. Any other service is added manually: base URL, path, auth scheme, model list.

## Installation

### Ready-made archive

Grab the ZIP from [Releases](https://github.com/Smokelweiss/OpenSummary/releases/latest) and unzip it — building from source is optional. The `npm run icons` / `npm run build` steps below are only needed when working on the code.

### Chrome / Edge / Opera (unpacked extension)

1. `npm run icons` and `npm run build` — this creates `dist/opensummary-chrome/` and the ZIP archive.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `dist/opensummary-chrome`.
3. Open any YouTube video: the OpenSummary button appears in the bottom-right corner.

### Firefox

`dist/opensummary-firefox/` is a build with an event page instead of a service worker (`about:debugging` → **This Firefox** → **Load Temporary Add-on** → `manifest.json`). Firefox 128 or newer is required (it fully supports MV3 background modules and `optional_host_permissions`).

### First run

* Open Settings → **AI providers** → "Add provider" → pick a service → paste the API key → "Test connection" → "Save". After that the **Summarize** button in the panel produces a model-written summary.

## Usage

* **The on-page button** or `Alt+Shift+S` — open/close the panel; `Alt+Shift+D` — summarize right away.
* **The extension popup** — "Summarize with AI" for the active tab and a list of recent summaries.
* **Timecodes** in the summary are clickable — the player jumps to that moment.
* **Export**: at the bottom of the panel — "Copy" and "Download" (Markdown / text / JSON, optionally together with the transcript).
* **Only what matters on screen.** The header has two tabs (Overview, Q&A) and three buttons: summarize, quick settings, close. Mode, provider, model, language and length live in the quick settings behind the gear, on a single line, with "All settings" to the right. Stats, keywords, entities and number checks sit under the collapsed "Run details" at the bottom. There are no separate "Sections", "Timeline" and "Transcript" tabs: sections live in Overview, and YouTube has its own searchable transcript panel. The panel is light by default; the theme switch is the sun/moon in the header (or "Settings → Panel theme").
* **No captions?** The panel takes the text from the built-in "Transcript" panel on the page: the extension opens it in the background and closes it immediately, so the page neither jumps nor scrolls. If that is not available either, you get a clear error with a "Grab transcript from page" button instead of an empty panel. Manual text pasting is gone.

## Speed

Streaming items are rendered at most once per frame, and reading the transcript from the page never shows YouTube's panel: it is moved off-screen before it appears, closed, and put back, while the page itself does not shift — the player stays exactly where it was on screen. The browser E2E measures panel opening, rendering of the finished answer and time to the first item, and fails when a budget is exceeded.

## Settings

* **Interface** — language, theme, panel width and display mode (built-in column or overlay), autostart.
* **Summary** — output language, length, tone, timestamps, custom instructions for the model.
* **AI fine-tuning** — strategy (auto / single request / map-reduce), context budget, chunk size, parallel requests, temperature, response token limit, retries, timeout, streaming, backup provider, summary cache and chunk-analysis cache, custom system prompt.
* **Data & privacy** — where keys are stored (persistently or until the browser closes), cache and history, export/import, reset.

## Privacy

* API keys and settings are stored **only in your browser** (`chrome.storage`) and are never sent to the developer.
* What goes to the provider is **the caption text** and the summarization request — nothing else. The provider host is shown in Settings, and access to arbitrary hosts is requested separately. The fallback transcript search runs offline and sends nothing.
* No analytics, no telemetry. Details in [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm test          # 361 tests: AI on mock providers, streaming protocol, captions, background (chrome stub), panel on a stub DOM, YouTube response import, hostile corpus and parse fuzzing
npm run quality   # offline measurement without a model: chunk boundaries at topic shifts and overlap
npm run fixture -- status  # import/clear a real ytInitialPlayerResponse: analyze|sanitize|status (tests/fixtures/youtube/)
npm run e2e       # real Chrome/Chromium: draft, final, fallback and AUTH; screenshots in dist/e2e-artifacts/
npm run e2e:rounds -- --cycles 20   # repeated runs across transcript routes; report in dist/e2e-rounds/
OSUM_YOUTUBE_TEST_URL="https://www.youtube.com/watch?v=..." npm run e2e:youtube
                  # live YouTube (captions + manual insert), AI is a local mock; network required
                  # --cycles N repeats the whole path N times (measures the success rate),
                  # OSUM_CHROME_PROXY=socks5://127.0.0.1:9150 for networks where youtube.com
                  # is blocked: the test browser goes through your local proxy/VPN
npm run live      # live loop: real YouTube + OpenRouter in real Chrome, report and screenshots
                  # key only from OSUM_OPENROUTER_KEY / --key-file outside the repository; see below
npm run bench     # manual live measurement: --live --transcript=FILE + OPENROUTER_API_KEY (flags: --help)
                  # without a key: --live --mock --synthetic (SSE mock) and --no-stream for comparison
npm run bench:sim # offline stand without a key: requests, map waves, reduce rounds, critical path
npm run bench:report # median and spread across several live reports
npm run icons     # generate PNG icons (own encoder, no dependencies)
npm run check     # static checks: syntax, manifest, page element ids, imports and exports,
                  # message and port types, calls to unknown functions, secret scan
npm run build     # build dist/ (Chrome + Firefox, ZIP and unpacked folders)
```

There are no dependencies at all: everything runs on the Node ≥ 18 standard library. No build step is needed — the extension loads from the sources as is. The browser E2E finds Chrome/Chromium itself (or takes `OSUM_CHROME` / `--chrome`), builds the extension, serves a local page and an SSE mock, and never touches the regular build. The separate online scenario `npm run e2e:youtube` opens a real video (URL in `OSUM_YOUTUBE_TEST_URL`) in a temporary profile and checks caption retrieval and the manual insert; the AI provider there is a mock too, so no key is needed. The live benchmark is run manually: `npm run bench -- --live --transcript=FILE` with the key in an environment variable; `npm run bench -- --help` lists all flags.

The `npm run live` loop is the full path "real YouTube → real provider → panel": a temporary Chrome profile, a real OpenRouter key from an environment variable or a file outside the repository, a report in `dist/live-artifacts/report.jsonl` (error code, strategy, time to the first item, counters) and a screenshot of every failure. `--repeat N` runs the same video several times (cache disabled), which measures the success rate rather than one lucky run. The key is never written to the project, a log or a report.

### Structure

```
src/
  common/      constants, utilities, Chrome/Firefox compatibility, storage layer
  nlp/         result schema and renderers, fallback transcript search (BM25)
  transcript/  YouTube caption retrieval (page + InnerTube), json3/vtt/srv1/srv3 parsing
  ai/          provider catalog, universal client, chunking, prompts, JSON repair, pipeline
  background/  service worker: message routing, task ports, cache, transcripts
  content/     in-page panel (Shadow DOM), i18n, styles, export, transcript DOM fallback
  popup/       extension popup
  options/     settings page
tools/         icon generator, zip packer, build, checks
tests/         tests and fixtures
tests/e2e/     browser stand (Chrome over CDP, SSE mock, stub and live YouTube)
```

### Architecture in a nutshell

* The service worker is the only place where network requests and model calls happen. Content scripts only draw the UI.
* Captions are fetched in three ways (in this order): `api/timedtext` via the track from the player data → `youtubei/v1/get_transcript` (the very request the "Show transcript" panel makes; no PO token needed) → reading the already rendered panel on the page. The last option is the fallback: it is needed when both APIs refuse; the panel is hidden before it appears, closed right after reading, and the page stays in place — the extension keeps the player at the same point on screen.
* Content scripts are classic scripts without modules, sharing the `window.OSUM` namespace.
* Long tasks run over a `Port` (`osum-task`) with `stage / progress / stream-item / result / error / done` events and a keepalive every 15 seconds — that is how verified items appear before the final answer, and how the run can be cancelled.
* The model response is normalized into **one schema**, `SummaryResult` (see `src/nlp/schema.js`), so the UI and export do not depend on the provider.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "This video has no captions" | Turn on CC on the page and run the analysis again — or press "Grab transcript from page" |
| "The track is protected by a PO token" (`POT_REQUIRED`) | The extension first tries `youtubei/v1/get_transcript` on its own — the same request the "Show transcript" panel makes, and it needs no PO token. If that fails too, press "Grab transcript from page" (it reads the open panel) or paste the text manually. "Run details" now shows exactly what the scraper found: `panel`, `rows`, `timecode cells`, `duration` |
| "The Transcript panel was not found on the page" | Expand the description and press "Show transcript" — or open the "In this video" panel → "Show transcript". If the panel is open on the Chapters tab, the extension switches it to the transcript tab itself and re-reads the rows. Rows are located by timecodes, whatever the markup. If the video has no panel at all (captions were never published), there is nothing to summarize. Long videos are scrolled to the end, so the scan takes a few seconds |
| "The model hit its token limit and returned no text" (`TRUNCATED`) | This is typical of "thinking" models. Increase "Max response tokens", pick a model without a reasoning mode, or switch to the chunked strategy — the extension retries with a larger limit on its own |
| AI gave no answer (`EMPTY_RESPONSE`, `EMPTY_RESULT`, timeout) | The panel shows a card with the reason and a hint, and if a summary was already on screen (from the cache, for instance) it stays under the card — no red banner instead of the result. "Retry" runs it again (after switching the model, for example), "Settings" opens the providers. One empty answer gets a second chance: the extension repeats the request in a compact format (1600 tokens, 45 s) |
| "The model answered with text but no JSON" (`BAD_JSON`) | The model ignored the JSON format. The extension already retries in a compact format; if that does not help, pick a model without a reasoning mode or shorten the summary. "Run details" shows the text the model returned |
| "Instead of a summary the model returned a safety verdict" (`MISROUTED_MODEL`) | A free router sent the request to a classifier model (`User Safety: safe` and the like). A retry almost always lands on a writing model; if it keeps happening, choose a specific model instead of `openrouter/free` |
| "The background process did not respond" (`WORKER_SILENT`) | The panel received no events and no replies to its pings for more than 30 s — the background process usually restarted. Press "Retry"; if that does not help, reload the tab. A model that "thinks" for a long time before the first token no longer triggers this error: pings keep the run alive |
| The model answers with "reasoning" only | Some free models return empty text and put their thinking into the `reasoning` field (`openrouter/free` is the typical case). The extension uses that field as the answer, and if there is no JSON in it, suggests switching to a model without a reasoning mode |
| The provider's model list is outdated | Press ⟳ next to the model list in the panel (or "Load models" in Settings) — the list is refreshed from the provider API |
| AI: "Key rejected (401)" | Check the key and access to the selected model; press "Test connection" in Settings |
| AI: "Provider requires payment (402)" | Choose a free model (one with the `:free` suffix, for example) or another provider |
| AI: "Too many requests (429)" | Lower "Parallel requests", wait a minute, or enable a backup provider |
| Local model unavailable | Start the server (`ollama serve`), check the port and allow access to `localhost` in Settings |
| "The transcript did not fit the context" | Lower "Chunk size" — the pipeline will split the video into more parts |
| After the background process restarts | The panel shows a separate **"Continue"** button with the number of finished chunks and the reason it stopped; continuing does not pay for them twice. If the data has changed, the button is gone; cancelled and finished jobs are not resumed |
| "Incomplete coverage" (`meta.complete=false`) | Some chunks failed after retries (time limit, model error or empty answers). The summary is built from the successful parts only and is not cached: lower "Chunk size", reduce parallelism, or switch the model and retry |
| "One request instead of chunks" | Check "Context budget" in the AI settings: it must match the model window. For `openrouter/free`, 128 000 of the declared 200 000 is safe. If the provider still returns a context error, the extension switches to chunks on its own |

In Settings → "About" → "Copy diagnostics" builds a report without keys — handy to attach to an issue. It also includes the **transcript journal**: the last 20 attempts with the route (`timedtext` / `get_transcript` / page panel), the error code and the scraper counters (`panel`, `rows`, `cells`, `duration`), oldest to newest.

## License

AGPL-3.0 — see [LICENSE](LICENSE). The code may be used, modified and distributed under the terms of this license; if a modified version is offered as a network service, its source code must be published under the same terms.


