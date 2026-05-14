# Slack Bot Kit Reference

> Source: https://api.slack.com/partners/thinking-steps  
> Non-standard / partner block types not available in Block Kit Builder.
> Verify availability against your workspace's bot token before using.

---

## `task_card` block

An inline accordion block that renders a collapsible task result — title, optional details,
and output — directly in a message or thread without opening a modal. Designed for
streaming AI "thinking steps" but usable for any reveal-style content.

### Usage in evolving-mind-ai

Used by the `reveal` gate field. When the user clicks the "Show Definition" button on a
`human_gate`, `handlePeekReveal` in `interactive.mjs` posts a `task_card` block as a
thread reply with the resolved `content`. The gate remains suspended; the card is
read-only and does not advance the workflow.

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"task_card"` | Yes | Block type discriminator |
| `task_id` | UUID string | Yes | Unique identifier for this card; use `randomUUID()` |
| `title` | string | Yes | Heading shown on the card (collapsed and expanded) |
| `status` | string | Yes | `"in_progress"` or `"complete"` |
| `details` | rich_text object | No | Secondary context shown alongside the title |
| `output` | rich_text object | No | Main body content, shown expanded |

### `status` values

| Value | Behaviour |
|---|---|
| `"in_progress"` | Card shows a spinner; intended for streaming/live updates |
| `"complete"` | Card shows finished state; output is fully rendered |

### Minimal example — reveal gate

```json
{
  "type": "task_card",
  "task_id": "bb9cb0c7-bf08-4eed-9e44-3ee71ef021a6",
  "title": "Show Definition",
  "status": "complete",
  "output": {
    "type": "rich_text",
    "elements": [
      {
        "type": "rich_text_section",
        "elements": [
          { "type": "text", "text": "The resolved definition text goes here." }
        ]
      }
    ]
  }
}
```

### Full example — with details and rich output

```json
{
  "type": "task_card",
  "task_id": "bb9cb0c7-bf08-4eed-9e44-3ee71ef021a6",
  "title": "Demonstrating Task Card Block Features...",
  "status": "in_progress",
  "details": {
    "type": "rich_text",
    "elements": [
      {
        "type": "rich_text_section",
        "elements": [
          { "type": "text", "text": "Fetching from " },
          {
            "type": "link",
            "url": "https://api.slack.com/partners/thinking-steps",
            "text": "This Thinking Steps"
          }
        ]
      }
    ]
  },
  "output": {
    "type": "rich_text",
    "elements": [
      {
        "type": "rich_text_section",
        "elements": [
          {
            "type": "text",
            "text": "This task card shows how timeline mode interleaves text and tool calls in streaming content, making it ideal for short, naturally flowing tasks, unlike plan mode which groups tasks under a shared goal."
          }
        ]
      }
    ]
  }
}
```

### Notes

- `task_id` must be unique per card; generate with `randomUUID()` from `node:crypto`.
- `output` uses the `rich_text` block format, not `mrkdwn`. Plain text content goes in
  a `rich_text_section` → `rich_text` element. Links use a `link` element with `url` + `text`.
- `details` is optional; omit it when there is no secondary context to show.
- This block type is not available in Block Kit Builder — test only in a live workspace.
- `trigger_id` is not needed; post via `chat.postMessage`, not `views.open`.
