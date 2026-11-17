# OpenSummary — Privacy Policy

Last updated: 2026-10-19

OpenSummary is a YouTube summarizer browser extension with two engines: a fully
local (on-device) engine and an optional AI engine that talks to a provider
**you** configure.

## Short version

- We (the developers of OpenSummary) collect **nothing**. There is no OpenSummary
  server, no analytics, no telemetry, no ads.
- In **local mode** nothing ever leaves your computer. The video transcript is
  processed inside your browser. The one exception is the optional summary
  translation: it is off by default, and when enabled only the **finished
  summary text** (a few thousand characters) is sent to the translator you
  choose — never the transcript.
- In **AI mode** the transcript (and your question, if you use Q&A) is sent
  **directly from your browser to the API endpoint you configured**. Nothing is
  proxied through us, because we have no servers.

## What data is stored, and where

Everything is stored on your device using the browser's extension storage
(`chrome.storage` / `browser.storage`):

| Data | Where | Notes |
| --- | --- | --- |
| Extension settings | `storage.local` | output language, summary options, UI preferences |
| Provider list | `storage.local` | base URLs, model names, headers — no secrets |
| API keys | `storage.local` (or `storage.session` if you enable "session-only keys") | Never transmitted anywhere except the provider endpoint they belong to |
| Summaries cache | `storage.local` | Lets us show a cached summary instantly. Incomplete runs are never cached |
| Fragment notes cache (AI map-reduce) | `storage.local` | Intermediate notes for transcript fragments, bounded to 400 entries / 14 days; contains no API keys |
| Unfinished AI job state | `storage.local` | Transcript fingerprint, chunk statuses and saved notes used to resume after the browser stops the background worker; pruned after 24 hours |
| History | `storage.local` | Last N summarized videos, can be cleared any time |
| Transcripts | in-memory only | Not persisted by default; used to build the summary |

You can export, import and wipe all of it from **Settings → Data**.

## What is transmitted, and to whom

Only in AI mode, only to the endpoint you configure (for example
`api.openai.com`, `openrouter.ai`, `generativelanguage.googleapis.com`,
`localhost:11434`, or your own self-hosted model):

- the video transcript (text with timecodes),
- the video title/channel/duration as context,
- your configured system prompt / custom instructions,
- your Q&A question,
- your API key, as an authentication header.

The recipient's own privacy policy applies to that data. If you do not want any
data to leave your device, use **local mode** only, or point AI mode at a model
running on your own machine (Ollama, LM Studio, llama.cpp, vLLM).

## Network access summary

- `*.youtube.com` — to read the video page and its caption/transcript tracks.
- the API endpoints of the AI providers you add — and nothing else.
- `api.mymemory.translated.net`, or the LibreTranslate server you enter — only
  when summary translation is enabled, and only the finished summary text is
  sent (never the transcript).
- No other host is contacted. Host permissions for third-party endpoints are
  requested at runtime, only when you add such a provider or a translation
  server.

## Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | settings, cache, history |
| `scripting` | show the panel on already-open YouTube tabs after install/update |
| `tabs` | find the active YouTube tab from the popup |
| `alarms` | periodic cache cleanup |
| `contextMenus` | "Summarize this video" on YouTube links |
| `downloads` | save a summary as Markdown/JSON/TXT |

## Children / sensitive data

OpenSummary is a general-purpose tool and does not knowingly collect any
personal data at all.

## Changes

This policy is versioned with the extension; material changes will be listed in
`CHANGELOG.md` and in the extension's update notes.

## Contact

Open an issue in the project repository.
