# TAKA Tales — AI-Native Interactive Audio Stories for Kids

> [中文说明](README.md) | **English**

> **In one line**: an interactive narrative product for children aged 3–6 — kids move the story forward with their own choices and words, finish a chapter, and take home an audio story of their very own.
>
> **Our core belief**: we don't build idols; we build mirrors. The AI never decides for the child — it responds to what the child decides.

![Status](https://img.shields.io/badge/status-live-brightgreen) ![i18n](https://img.shields.io/badge/language-%E4%B8%AD%2FEN-blue)

**Live product (3 bilingual chapters, continuously updated)**: [takatales.com](https://takatales.com) — plays directly in mobile/tablet browsers.

---

## What is TAKA?

TAKA is a rusty tin robot about to be scrapped. It got a new battery (an LLM) and is now trying to find its place in a new era. It longs to make friends with humans.

Kids experience stories alongside TAKA, pressing "I want to know" on its behalf at each turning point. There are no correct answers, no punishment, and no princesses waiting to be rescued — all the wisdom, courage and curiosity belong to the child. TAKA is just the mirror: you shine, and it shines.

It speaks little and is often silent, answering with blinks of its light instead.

> "The sea bottom is full of lights."
> "What's up there? I want to know."
> "Let's go up. Together."

![Hand-drawn illustration of the first chapter's climax: sunrise, sea, a seagull and TAKA](demo/assets/arts/taka-seagull-sunrise.jpg)

*Hand-drawn art: the climax — TAKA surfaces and hears the wind for the first time. The sun has risen.*

## Quick Start

**① Live version**: open [takatales.com](https://takatales.com) — multiple chapters, Chinese/English, landscape picture-book mode, cloud-synced progress. No installation needed.

**② Single-file demo (zero setup)**: open `demo/taka.html` in any browser to play chapter 1, *The First Time I Heard the Wind* — prologue, dream-delay branch, two endings, a battery state machine and achievements. Nothing punishes the child.

```bash
git clone https://github.com/AmeliaCai67/TAKA_tales.git
# then open demo/taka.html in your browser
```

`index.html` at the repo root is a landing page that redirects to the demo.

**Multi-story player (`apps/player`, Vite + TypeScript)**: a story shelf, choice-C free input caught by AI in real time, voice performances. It requires a backend (generation/speech services) which is **not** part of this public repo — deployers bring their own; static-only deployments keep the core gameplay intact (see the telemetry note below).

## Product Form

- **Stories are content packs**: each chapter is a single `story.json` (scenes/branches/battery/achievements/codex/audio manifest), fully decoupled from the engine — `packages/story-schema` ships the JSON Schema and a structural validator (branch closure, scene reachability, audio coverage, zh/en parity). New chapters ship without touching a line of engine code.
- **Landscape picture-book mode**: on wide screens/tablets the player enters a 16:9 book stage — hand-painted backgrounds and ambient character performances on the left page, a flowing speech-bubble column on the right; choices materialize as glowing hotspots inside the scene, with three layout modes (book / novel / auto).
- **Kids really change the story**: branching choices at key nodes; free text/voice input at low-stakes nodes, caught by AI and bridged back into the plot (anonymous visitors included, per-device daily quota); graceful fallback on generation failure — the story never breaks.
- **Memory bank (codex)**: story keywords glow warm-yellow once typed out and can be tapped → an entry card (properly licensed real photos + curated science facts + TAKA's take + read-aloud); three-state progressive unlocking, progress isolated per story × child.
- **Our Books**: a journey log collects dialogue as the child plays; finishing a chapter binds it into a book and exports a personal audiobook MP3 — every playthrough becomes a keepable work, not a chat that vanishes.
- **Battery mechanic**: scenes cost battery, the sun charges it back, running out triggers a system-level ending — session length is naturally bounded by the narrative itself; anti-addiction without a kill switch.
- **Voice performances**: pre-rendered mp3s with fixed character voices for scripted scenes, server-side TTS for dynamic text; a global speed slider; an audio-priority bus keeps codex narration and story speech from fighting.
- **Multi-child shelf**: cover cards, three-state badges (new / in progress / finished), achievement counts, child switching; notification dots light up on the Books/Achievements/Memory-bank buttons when there's something new.

## Safety: Engineering, Not Slogans

For an audience of 3–6-year-olds, content safety is a pipeline embedded in the creative process, not a pre-launch manual review:

- **Red-line rule library** (output validator): death/violence/religious vocabulary, obedience-preaching phrases, gender stereotypes and pronouns, character-body continuity ("TAKA has no mouth; no legs underwater"), AI-speaking-for-the-child, format pollution — substring hit = rejection; rules only ever grow;
- **Three-way input triage**: free input is classified first — meaningful input generates and advances, nonsense holds the scene in place, profanity gets zero feedback and no progression;
- **Constrained generation**: the AI only fills in blanks inside the authored plot skeleton; all calls are server-side (zero keys in the client) and fully audit-logged;
- **Parent dashboard**: play records, free-input dialogues (including blocked ones), and a per-child "allow free input" switch enforced server-side.

## Optional Telemetry (Transparency Note)

`apps/player` ships an optional "anonymous visitor analytics" module (`src/anon.ts`): in guest mode it silently reports play progress/achievements/session events to the site's `/api/anon/*` endpoints (device is a random UUID; no personally identifiable information).

- **Static-only deployments** (e.g. GitHub Pages) have no backend; requests 404 silently and nothing breaks;
- **Data belongs to the deployer**; no third-party tracking; remove the module if you don't want it;
- It never affects core gameplay; logged-in users go through the proper account pipeline, not this module.

## Why Not a "Perfect Idol"?

The traditional content industry trains consumers to worship perfect idols, then collapses collectively when the idol shows any human flaw. The next generation of children doesn't need gods — they need to see themselves.

| ❌ You will never see in TAKA | ✅ Instead |
|--------|--------|
| Sacrificing oneself to save others | "Let's figure it out together" |
| Gender stereotypes (princess waiting to be rescued) | All characters are neutral; ability is decoupled from gender |
| "Good kids obey" | "Want to try?" / "You decide." |
| Evil must be destroyed | "Things you don't understand can be avoided — or talked to" |
| "You are special / the chosen one" | "You are here. That's enough." |
| Religious vocabulary | Sci-fi concepts (energy, signals, memory bank) |

## Repository Layout

This repo is the open part of the product; core content assets and generation-control logic stay private. The boundary, for deployment and hacking:

| Path | Status | Notes |
|------|--------|-------|
| `apps/player/` | ✅ open | Player engine (shelf / book mode / dialogue flow / achievements / codex / our-books) |
| `packages/story-schema/` | ✅ open | Content-pack schema + structural validator |
| `content/stories/ch01-wind/` | ✅ open | Complete content pack for chapter 1, *The First Time I Heard the Wind* |
| `demo/` · `index.html` · `hackathon/` | ✅ open | Single-file demo / landing page / pitch deck |
| `content/stories/ch02+` | 🔒 private | Later chapters (core content assets) |
| Backend / parent dashboard / red-line & prompt library | 🔒 private | Generation control, data panels and safety assets |

## Tech Stack

| Layer | Choice | Notes |
|------|------|------|
| Frontend | Vite + TypeScript + vanilla CSS | Visual-novel + picture-book dual form, no heavy frameworks |
| Content | story.json packs + JSON Schema | content/engine decoupling; validator guards structural correctness |
| Speech | Server-side edge-tts | Pre-rendered audio packs + dynamic real-time TTS, disk-cached |
| AI layer | Multi-model division of labor | Plot-fill generation + heterogeneous safety-review models; server-side only, zero keys in the client |

## Roadmap

- [x] Single-file demo prototype (branches / battery / achievements / dual endings)
- [x] Multi-story player engine: content packs decoupled from the engine + validator
- [x] Three chapters live (Chinese & English content packs)
- [x] Memory bank + Our Books (journey log / audiobook export)
- [x] Landscape picture-book mode (16:9 book stage + hotspot choices + page turns)
- [x] Voice input v2 (hold to talk / slide-up-to-edit; auto-degrades on unsupported devices)
- [x] Live operations (accounts / child profiles / cloud progress / parent dashboard)
- [ ] Chapter 4 (in production)
- [ ] Mobile app store release (in preparation)
- [ ] Content library expansion and more story templates

---

*Status: live at [takatales.com](https://takatales.com) with three bilingual chapters; chapter 4 in production. License TBD.*
*TAKA's battery reads: remaining lifespan, unknown. But today, it wants to hear the wind above.*
