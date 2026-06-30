# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository contains a Microsoft Edge / Chromium Manifest V3 extension that converts article pages into a reader-mode overlay and narrates them with the browser Web Speech API.

## Commands

- Install dependencies: `bun install`
- Development build/watch: `bun run dev`
- Production build: `bun run build`
- Type check: `bun run typecheck`
- Run tests: `bun run test`

Build output is written to `dist/`. Load that directory as an unpacked extension from `edge://extensions` with developer mode enabled.

## Architecture

- `manifest.json` is the source Manifest V3 file. `scripts/copy-manifest.mjs` copies it to `dist/` after Vite builds JS entries.
- `src/background/service-worker.ts` handles toolbar activation, content script injection, settings messages, and background fetches for next-page preloading.
- `src/content/content-script.ts` owns reader-mode lifecycle in the active tab.
- `src/content/extract-readable-page.ts` uses `@mozilla/readability` and DOMPurify to extract/sanitize readable page content and produce speech segments.
- `src/content/reader-overlay.ts` renders the Shadow DOM reader UI and coordinates speech, click-to-start, settings, and next-page auto-advance.
- `src/content/speech-controller.ts` wraps `speechSynthesis` and reads one segment at a time.
- `src/content/next-page-detector.ts` detects likely next-page links.
- `src/shared/` contains message and page model types shared between background and content code.

Important limitation: Edge's native Read Aloud UI is not publicly controllable from extensions. This project uses Web Speech API voices exposed by the browser/OS.
