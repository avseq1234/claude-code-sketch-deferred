# claude-code-sketch-deferred

A fork of [allen-hsu/claude-code-sketch](https://github.com/allen-hsu/claude-code-sketch) (MIT) with one change: the 17 drawing tools are **deferred**, so they load through ToolSearch only when a card is needed.

## Why

The upstream plugin registers every tool with `isDeferred: false`, so all 17 tool schemas load into every session (about 6,500 tokens). With this fork a session pays only for the tool names and the short standing instruction, about 1,100 tokens measured. A card request then fetches just the one tool it needs.

## Changes from upstream

- `isDeferred: false` → `true` in `hooks/register.tsx`
- One line added to the standing instruction: load a sketch tool with ToolSearch before its first call
- Marketplace renamed to `sketch-deferred`; docs images, previews and the zh-TW README left out

## Install

```
claude plugin marketplace add avseq1234/claude-code-sketch-deferred
claude plugin install sketch@sketch-deferred --scope user
```

Start a new session, then ask for a visual: "draw the architecture as a diagram", "chart these numbers", "make a timeline". See the upstream README for the full list of cards.

## Credit

All drawing code is by allen-hsu. License: MIT, see `LICENSE`.
