---
title: Advanced Markdown
description: Examples of rich markdown supported by the renderer.
---

# Advanced Markdown

## Alerts

> [!NOTE]
> This is a note.

> [!IMPORTANT]
> This is important information.

> [!WARNING]
> This warns about risky actions.

> [!CAUTION]
> This highlights critical caution.

> [!SUCCESS]
> A custom success alert alias.

> [!ERROR]
> A custom error alert alias.

## Table

| Feature | Status |
| --- | --- |
| GFM tables | ✅ |
| Task lists | ✅ |
| Footnotes | ✅ |

## Task List

- [x] Configure GitHub integration
- [x] Edit markdown in browser
- [ ] Add additional team workflows

## Code Block

```ts
export const hello = (name: string) => `Hello, ${name}`;
```

## Footnote

Footnotes are supported.[^1]

[^1]: Example footnote content.
