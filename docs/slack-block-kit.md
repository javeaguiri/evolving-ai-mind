# Slack Block Kit Reference

> Sources: https://docs.slack.dev/block-kit · https://api.slack.com/partners/thinking-steps  
> Examples captured from live Slack workspace — responses show actual payloads,
> not Block Kit Builder simulations. Block Kit Builder cannot simulate interactive
> responses (button clicks, form submissions) — those responses require a live app.
> Partner block types (see section below) are not available in Block Kit Builder.

---

## Concepts

Block Kit is built from three layers:

- **Blocks** — visual layout components (`section`, `actions`, `input`, `context`, `divider`, `header`, `image`, `markdown`)
- **Block elements** — interactive components inside blocks (`button`, `plain_text_input`, `static_select`, `radio_buttons`, `overflow`)
- **Composition objects** — reusable text and option structures (`plain_text`, `mrkdwn`, `option`, `confirm`)

Blocks are placed in a `blocks` array and sent to a surface (message, modal, or Home tab). Up to 50 blocks per message; up to 100 blocks per modal or Home tab.

### Surface compatibility

| Block type | Messages | Modals | Home tab |
|---|---|---|---|
| `section` | Yes | Yes | Yes |
| `actions` | Yes | Yes | Yes |
| `input` | Yes* | Yes | Yes |
| `context` | Yes | Yes | Yes |
| `divider` | Yes | Yes | Yes |
| `header` | Yes | Yes | Yes |
| `markdown` | Yes | No | No |

*`input` blocks render in messages but their `state.values` are only populated in the interaction payload when the user clicks a button in the same message. Block Kit Builder cannot simulate this — the `value` field will appear as `null` in the builder's preview even though it populates correctly in a live Slack channel.

### Response payload types

| User action | Payload type | Received by |
|---|---|---|
| Button click in a message | `block_actions` | `/interactive` endpoint |
| Modal Submit button | `view_submission` | `/interactive` endpoint |
| Modal Close button | `view_closed` | `/interactive` endpoint (if `notify_on_close: true`) |

All `block_actions` payloads include `trigger_id` — required to open a modal within the 3-second window.

---

## Template — multi-block message

A representative layout using section, image, accessory, divider, and context blocks.

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Hey there \ud83d\udc4b I'm TaskBot. I'm here to help you create and manage tasks in Slack.\nThere are two ways to quickly create tasks:"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*1\ufe0f\u20e3 Use the `/task` command*. Type `/task` followed by a short description of your tasks and I'll ask for a due date (if applicable)."
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*2\ufe0f\u20e3 Use the _Create a Task_ action.* Select `Create a Task` in a message's context menu."
      }
    },
    {
      "type": "image",
      "title": { "type": "plain_text", "text": "image1", "emoji": true },
      "image_url": "https://api.slack.com/img/blocks/bkb_template_images/onboardingComplex.jpg",
      "alt_text": "image1"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "\u2795 To start tracking your team's tasks, *add me to a channel* and I'll introduce myself."
      },
      "accessory": {
        "type": "conversations_select",
        "placeholder": { "type": "plain_text", "text": "Select a channel...", "emoji": true }
      }
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "\ud83d\udc40 View all tasks with `/task list`\n\u2753 Get help at any time with `/task help`"
        }
      ]
    }
  ]
}
```

---

## Input blocks

### Text input (single-line)

No `block_id` specified — Slack assigns a random one. The `action_id` is the key used
to retrieve the value from `state.values` in the interaction payload.

```json
{
  "blocks": [
    {
      "type": "input",
      "element": {
        "type": "plain_text_input",
        "action_id": "plain_text_input-action",
        "placeholder": {
          "type": "plain_text",
          "text": "Write something"
        }
      },
      "label": {
        "type": "plain_text",
        "text": "Label",
        "emoji": true
      },
	  "optional": false
    }
  ]
}
```

### Multi-line text input in a message

`input` blocks work in messages. The `state.values` in the response payload is populated
with the typed text when the user clicks the Submit button. Block Kit Builder shows `null`
for this value because it cannot simulate live user input — in a real Slack channel it
contains whatever the user typed.

#### Code
```json
{
  "blocks": [
    {
      "type": "input",
      "block_id": "note_input_block",
      "element": {
        "type": "plain_text_input",
        "action_id": "note_text_action",
        "multiline": true,
        "placeholder": { "type": "plain_text", "text": "Enter your notes here..." }
      },
      "label": { "type": "plain_text", "text": "Notes" }
    },
    {
      "type": "actions",
      "block_id": "button_actions_block",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Submit" },
          "style": "primary",
          "action_id": "action_submit",
          "value": "submit_clicked"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Cancel" },
          "style": "danger",
          "action_id": "action_cancel",
          "value": "cancel_clicked"
        }
      ]
    }
  ]
}
```

#### Response (block_actions — live Slack channel)
```json
{
  "type": "block_actions",
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "container": { "type": "message", "text": "The contents of the original message where the action originated" },
  "trigger_id": "12466734323.1395872398",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavea-guiri" },
  "enterprise": null,
  "is_enterprise_install": false,
  "state": {
    "values": {
      "note_input_block": {
        "note_text_action": {
          "type": "plain_text_input",
          "value": "This is the text the user typed in the live Slack channel"
        }
      }
    }
  },
  "response_url": "%Slack-url%",
  "actions": [
    {
      "type": "button",
      "block_id": "button_actions_block",
      "action_id": "action_submit",
      "text": { "type": "plain_text", "text": "Submit", "emoji": true },
      "value": "submit_clicked",
      "style": "primary",
      "action_ts": "1777102743.324075"
    }
  ]
}
```

**Note:** `state.values` is keyed by `block_id` then `action_id`. When no `block_id` is
specified in the block definition, Slack assigns a random one (e.g. `"nBXMV"`). Always
specify explicit `block_id` values for `input` blocks so `state.values` can be read
reliably by key rather than by position.

---

## Select input

`static_select` inside an `input` block, with Submit/Cancel `actions` block.
The selected value appears in `state.values` keyed by the auto-assigned `block_id`.

#### Code
```json
{
  "blocks": [
    {
      "type": "input",
      "element": {
        "type": "static_select",
        "placeholder": { "type": "plain_text", "text": "Select an item", "emoji": true },
        "options": [
          { "text": { "type": "plain_text", "text": "Option 0", "emoji": true }, "value": "value-0" },
          { "text": { "type": "plain_text", "text": "Option 1", "emoji": true }, "value": "value-1" },
          { "text": { "type": "plain_text", "text": "Option 2", "emoji": true }, "value": "value-2" }
        ],
        "action_id": "static_select-action"
      },
      "label": { "type": "plain_text", "text": "Label", "emoji": true },
      "optional": false
    },
    {
      "type": "actions",
      "block_id": "button_actions_block",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Submit" },
          "style": "primary",
          "action_id": "action_submit",
          "value": "submit_clicked"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Cancel" },
          "style": "danger",
          "action_id": "action_cancel",
          "value": "cancel_clicked"
        }
      ]
    }
  ]
}
```

#### Response (block_actions)
```json
{
  "type": "block_actions",
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "container": { "type": "message", "text": "The contents of the original message where the action originated" },
  "trigger_id": "12466734323.1395872398",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavia-vida" },
  "enterprise": null,
  "is_enterprise_install": false,
  "state": {
    "values": {
      "nBXMV": {
        "static_select-action": {
          "type": "static_select",
          "selected_option": {
            "text": { "type": "plain_text", "text": "Option 1", "emoji": true },
            "value": "value-1"
          }
        }
      }
    }
  },
  "response_url": "%Slack-url%",
  "actions": [
    {
      "type": "button",
      "block_id": "button_actions_block",
      "action_id": "action_submit",
      "text": { "type": "plain_text", "text": "Submit", "emoji": true },
      "value": "submit_clicked",
      "style": "primary",
      "action_ts": "1777103260.962789"
    }
  ]
}
```

---

## Radio button input

`radio_buttons` inside an `input` block. Selected value appears in `state.values`.

#### Code
```json
{
  "blocks": [
    {
      "type": "input",
      "element": {
        "type": "radio_buttons",
        "options": [
          { "text": { "type": "plain_text", "text": "Option 0", "emoji": true }, "value": "value-0" },
          { "text": { "type": "plain_text", "text": "Option 1", "emoji": true }, "value": "value-1" },
          { "text": { "type": "plain_text", "text": "Option 2", "emoji": true }, "value": "value-2" }
        ],
        "action_id": "radio_buttons-action"
      },
      "label": { "type": "plain_text", "text": "Label", "emoji": true },
      "optional": false
    },
    {
      "type": "actions",
      "block_id": "button_actions_block",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Submit" },
          "style": "primary",
          "action_id": "action_submit",
          "value": "submit_clicked"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Cancel" },
          "style": "danger",
          "action_id": "action_cancel",
          "value": "cancel_clicked"
        }
      ]
    }
  ]
}
```

#### Response (block_actions)
```json
{
  "type": "block_actions",
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "container": { "type": "message", "text": "The contents of the original message where the action originated" },
  "trigger_id": "12466734323.1395872398",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavia-vida" },
  "enterprise": null,
  "is_enterprise_install": false,
  "state": {
    "values": {
      "exoHu": {
        "radio_buttons-action": {
          "type": "radio_buttons",
          "selected_option": {
            "text": { "type": "plain_text", "text": "Option 1", "emoji": true },
            "value": "value-1"
          }
        }
      }
    }
  },
  "response_url": "%Slack-url%",
  "actions": [
    {
      "type": "button",
      "block_id": "button_actions_block",
      "action_id": "action_submit",
      "text": { "type": "plain_text", "text": "Submit", "emoji": true },
      "value": "submit_clicked",
      "style": "primary",
      "action_ts": "1777104961.563772"
    }
  ]
}
```

---

## Modals

Modals are opened via `views.open` using a `trigger_id` from a button click or slash
command. They use `view_submission` payloads (not `block_actions`). Submit and Cancel
button labels are defined as top-level `submit` and `close` properties of the modal
view object, not as blocks.

### Multi-line input modal

#### Code — view object passed to views.open
```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "My App", "emoji": true },
  "submit": { "type": "plain_text", "text": "Submit", "emoji": true },
  "close": { "type": "plain_text", "text": "Cancel", "emoji": true },
  "blocks": [
    {
      "type": "input",
      "block_id": "note_input_block",
      "element": {
        "type": "plain_text_input",
        "action_id": "note_text_action",
        "multiline": true,
        "placeholder": { "type": "plain_text", "text": "Enter your notes here..." }
      },
      "label": { "type": "plain_text", "text": "Notes" }
    }
  ]
}
```

#### Response (view_submission)

The submitted text is at `payload.view.state.values[block_id][action_id].value`.

```json
{
  "type": "view_submission",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavia-vida" },
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "trigger_id": "123456789.123456789",
  "view": {
    "id": "V1234567890",
    "team_id": "T0ADHNQUB8T",
    "type": "modal",
    "callback_id": "",
    "private_metadata": "",
    "state": {
      "values": {
        "note_input_block": {
          "note_text_action": {
            "type": "plain_text_input",
            "value": null
          }
        }
      }
    },
    "hash": "1777104003.9UrGJ5Jo",
    "title": { "type": "plain_text", "text": "My App", "emoji": true },
    "submit": { "type": "plain_text", "text": "Submit", "emoji": true },
    "close": { "type": "plain_text", "text": "Cancel", "emoji": true },
    "clear_on_close": false,
    "notify_on_close": false,
    "previous_view_id": null,
    "root_view_id": "V1234567890",
    "app_id": "A02",
    "bot_id": "B00"
  },
  "response_urls": [],
  "is_enterprise_install": false,
  "enterprise": null
}
```

**Note:** `state.values.note_input_block.note_text_action.value` is `null` in this
captured response because the modal was submitted without entering text. In a live
submission with text, this field contains the typed string.

### views.open API call

```json
{
  "trigger_id": "YOUR_TRIGGER_ID_HERE",
  "view": {
    "type": "modal",
    "callback_id": "modal_identifier_123",
    "title": { "type": "plain_text", "text": "My App Modal" },
    "submit": { "type": "plain_text", "text": "Submit" },
    "close": { "type": "plain_text", "text": "Cancel" },
    "blocks": [
      {
        "type": "input",
        "block_id": "note_input_block",
        "element": {
          "type": "plain_text_input",
          "action_id": "note_text_action",
          "multiline": true,
          "placeholder": { "type": "plain_text", "text": "Enter your notes here..." }
        },
        "label": { "type": "plain_text", "text": "Detailed Notes" }
      }
    ]
  }
}
```

**Key fields:**
- `trigger_id` — required, expires after 3 seconds from the user action that generated it
- `callback_id` — identifies this modal in the `view_submission` payload received by `/interactive`
- `submit` / `close` — modal-level button labels; do NOT add button blocks for these
- Up to 100 blocks per modal

---

## Button patterns

### Choice gate — lettered buttons in a single actions block

All buttons in one `actions` block fire a single `block_actions` event. The clicked
button's `action_id` and `value` identify the selection.

#### Code
```json
{
  "blocks": [
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "A" },
          "action_id": "choice_A",
          "value": "option_a"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "B" },
          "action_id": "choice_B",
          "value": "option_b"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "C" },
          "action_id": "choice_C",
          "value": "option_c"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Cancel" },
          "action_id": "choice_cancel",
          "value": "cancel",
          "style": "danger"
        }
      ]
    }
  ]
}
```

#### Response (block_actions — user clicked C)
```json
{
  "type": "block_actions",
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "container": { "type": "message", "text": "The contents of the original message where the action originated" },
  "trigger_id": "12466734323.1395872398",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavia-vida" },
  "enterprise": null,
  "is_enterprise_install": false,
  "state": { "values": {} },
  "response_url": "%Slack-url%",
  "actions": [
    {
      "type": "button",
      "block_id": "7+Odf",
      "action_id": "choice_C",
      "text": { "type": "plain_text", "text": "C", "emoji": true },
      "value": "option_c",
      "action_ts": "1777106850.871749"
    }
  ]
}
```

**Note:** `state.values` is empty for pure button-only `actions` blocks — there are no
`input` blocks to capture. The selected value is read from `payload.actions[0].value`
and the selection identity from `payload.actions[0].action_id`.

### Section buttons (one button per row, with descriptive text)

Use when each option needs a description shown alongside the button. Each section fires
its own `block_actions` event independently.

#### Code
```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "This is option A with a description." },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "A", "emoji": true },
        "value": "click_A",
        "action_id": "button-action"
      }
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "This is option B with a description." },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "B", "emoji": true },
        "value": "click_B",
        "action_id": "button-action"
      }
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "This is option C with a description." },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "C", "emoji": true },
        "value": "click_C",
        "action_id": "button-action"
      }
    }
  ]
}
```

#### Response (block_actions — user clicked C)
```json
{
  "type": "block_actions",
  "user": { "id": "U0AD8M05TLP", "username": "javeaguiri", "name": "javeaguiri", "team_id": "T0ADHNQUB8T" },
  "api_app_id": "A02",
  "token": "Shh_its_a_seekrit",
  "container": { "type": "message", "text": "The contents of the original message where the action originated" },
  "trigger_id": "12466734323.1395872398",
  "team": { "id": "T0ADHNQUB8T", "domain": "xavia-vida" },
  "enterprise": null,
  "is_enterprise_install": false,
  "state": { "values": {} },
  "response_url": "%Slack-webhook-url%",
  "actions": [
    {
      "type": "button",
      "block_id": "0ubyu",
      "action_id": "button-action",
      "text": { "type": "plain_text", "text": "C", "emoji": true },
      "value": "click_C",
      "action_ts": "1777106391.916790"
    }
  ]
}
```

---

## Context block

Up to 10 elements per context block. Supports `plain_text`, `mrkdwn`, and `image` elements.

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        { "type": "plain_text", "text": "Author: K A Applegate", "emoji": true }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "image",
          "image_url": "https://pbs.twimg.com/profile_images/625633822235693056/lNGUneLX_400x400.jpg",
          "alt_text": "cute cat"
        },
        { "type": "mrkdwn", "text": "*Cat* has approved this message." }
      ]
    }
  ]
}
```

---

## Overflow accessory

A `...` menu attached to a section block. Supports a `confirm` dialog before the action
fires. Fires a `block_actions` event with the selected option's `value`.

```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Task: Review Q1 Project Plan*" },
      "accessory": {
        "type": "overflow",
        "action_id": "task_overflow_menu",
        "options": [
          { "text": { "type": "plain_text", "text": "Edit" }, "value": "edit" },
          { "text": { "type": "plain_text", "text": "Delete" }, "value": "delete" }
        ],
        "confirm": {
          "title": { "type": "plain_text", "text": "Confirm Action" },
          "text": { "type": "plain_text", "text": "Are you sure you want to proceed?" },
          "confirm": { "type": "plain_text", "text": "Yes" },
          "deny": { "type": "plain_text", "text": "No" }
        }
      }
    }
  ]
}
```

---

## Markdown block

`type: "markdown"` renders standard CommonMark-flavored markdown directly in a Slack message. Unlike `mrkdwn` (Slack's proprietary syntax), the `markdown` block type accepts the syntax LLMs naturally produce — `**bold**` instead of `*bold*`, `~~strikethrough~~`, fenced code blocks, tables, and standard link syntax.

**Used in evolving-mind-ai:** Novia (minds-eye agent) replies set `format: 'markdown'` on the `HUMAN_NOTIFICATION` callback payload, which routes to `markdownToBlocks()` in `callback.mjs` and emits `{ type: 'markdown', text }` blocks.

**Not available in Block Kit Builder** — test only in a live workspace.

### Formatting reference

```json
{
  "type": "markdown",
  "text": "Text can be **bold**, _italic_, ~~strikethrough~~, or `inline code`.\n\nCombine them: **_bold italic_** and [links](https://api.slack.com).\n\n> Blockquotes work too, with **formatting** inside."
}
```

### Code block example

````json
{
  "type": "markdown",
  "text": "Here is a JavaScript function:\n\n```javascript\nfunction greet(name) {\n  return \"Hello, \" + name + \"!\";\n}\n\nconsole.log(greet(\"world\"));\n```"
}
````

### mrkdwn vs markdown syntax

| Feature | `mrkdwn` | `markdown` block |
|---|---|---|
| Bold | `*bold*` | `**bold**` |
| Italic | `_italic_` | `_italic_` |
| Strikethrough | `~strike~` | `~~strikethrough~~` |
| Inline code | `` `code` `` | `` `code` `` |
| Fenced code block | Not supported | ` ```lang ``` ` |
| Link | `<url\|text>` | `[text](url)` |
| Blockquote | `>text` | `> text` |
| Table | Not supported | Standard markdown table |

---

## Partner block types

Non-standard blocks from the Slack partner API. Not available in Block Kit Builder — test
only in a live workspace. Source: https://api.slack.com/partners/thinking-steps

### `task_card`

An inline accordion that renders a collapsible task result — title, optional details, and
output — directly in a message or thread without opening a modal. Designed for streaming
AI "thinking steps" but usable for any reveal-style content.

**Usage in evolving-mind-ai:** the `reveal` gate field. When the user clicks "Show
Definition" on a `human_gate`, `handlePeekReveal` in `interactive.mjs` posts a `task_card`
block as a thread reply via `chat.postMessage`. The gate stays suspended; the card is
read-only and does not advance the workflow. `trigger_id` is not needed.

#### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"task_card"` | Yes | Block type discriminator |
| `task_id` | UUID string | Yes | Unique per card; generate with `randomUUID()` |
| `title` | string | Yes | Heading shown collapsed and expanded |
| `status` | string | Yes | `"in_progress"` (spinner) or `"complete"` |
| `details` | rich_text | No | Secondary context shown alongside the title |
| `output` | rich_text | No | Main body content |

#### Minimal example — reveal gate

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

#### Full example — with details and link in output

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

**Notes:**
- `output` uses `rich_text` format, not `mrkdwn`. Links use a `link` element with `url` + `text`.
- `details` is optional; omit when there is no secondary context.
- Post via `chat.postMessage`, not `views.open` — no `trigger_id` required.

---
## Overflow menu (hamburger expand icon)
```json
	"blocks": [
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": "This is a section block with an overflow menu."
			},
			"accessory": {
				"type": "overflow",
				"options": [
					{
						"text": {
							"type": "plain_text",
							"text": "*plain_text option 0*",
							"emoji": true
						},
						"value": "value-0"
					},
					{
						"text": {
							"type": "plain_text",
							"text": "*plain_text option 1*",
							"emoji": true
						},
						"value": "value-1"
					},
					{
						"text": {
							"type": "plain_text",
							"text": "*plain_text option 2*",
							"emoji": true
						},
						"value": "value-2"
					},
					{
						"text": {
							"type": "plain_text",
							"text": "*plain_text option 3*",
							"emoji": true
						},
						"value": "value-3"
					},
					{
						"text": {
							"type": "plain_text",
							"text": "*plain_text option 4*",
							"emoji": true
						},
						"value": "value-4"
					}
				],
				"action_id": "overflow-action"
			}
		}
	]
}
```

## Design notes for evolving-mind-ai

### choice gate rendering
Use a single `actions` block with lettered buttons when options are short labels (A, B, C).
Use section accessory buttons when each option needs a description alongside it.
Both patterns fire `block_actions`. The clicked button's `value` is the selected option.

### text_input gate rendering
`input` blocks work in both messages and modals. In messages, pair an `input` block with
an `actions` block containing Submit/Cancel buttons. The `state.values` in the resulting
`block_actions` payload contains the typed text at `state.values[block_id][action_id].value`.
Use explicit `block_id` values so the key is predictable.

### reveal gate rendering
Use a `task_card` block posted via `chat.postMessage` in the thread. Set `status:
"complete"`, `title` from `button_label`, and `output` as a `rich_text` section with the
resolved content string. No `trigger_id` needed — do not use `views.open` for reveal.

### trigger_id window
`trigger_id` from a button click expires after 3 seconds. If opening a modal in response
to a button click, `views.open` must be called before acknowledging the interaction or
from within the synchronous acknowledgement path. Any async processing (SQS round-trip)
will expire the `trigger_id` before the modal can be opened.

### Reading block_actions vs view_submission
- `block_actions`: selected value at `payload.actions[0].value`; typed input at `payload.state.values[block_id][action_id].value`
- `view_submission`: typed input at `payload.view.state.values[block_id][action_id].value`; modal identity at `payload.view.callback_id`

## Table of Block Elements

| Name | Description | Blocks | Surfaces |
|---|---|---|---|
| Button | Allows users a direct path to performing basic actions. | Section, Actions | Modals, Messages, Home tabs |
| Checkboxes | Allows users to choose multiple items from a list of options. | Section, Actions, Input | Modals, Messages, Home tabs |
| Date picker | Allows users to select a date from a calendar style UI. | Section, Actions, Input | Modals, Messages, Home tabs |
| Datetime picker | Allows users to select both a date and a time of day. | Actions, Input | Modals, Messages |
| Email input | Allows user to enter an email into a single-line field. | Input | Modals |
| Feedback buttons | Buttons to indicate positive or negative feedback. | Context actions | Messages |
| File input | Allows user to upload files. | Input | Modals |
| Icon button | An icon button to perform actions. | Context actions | Messages |
| Image | Displays an image as part of a larger block of content. | Section, Context | Modals, Messages, Home tabs |
| Multi-select menu | Allows users to select multiple items from a list of options. | Section, Actions, Input | Modals, Messages, Home tabs |
| Number input | Allows user to enter a number into a single-line field. | Input | Modals |
| Overflow menu | Allows users to press a button to view a list of options. | Section, Actions | Modals, Messages, Home tabs |
| Plain-text input | Allows users to enter freeform text data into a single-line or multi-line field. | Input | Modals, Messages, Home tabs |
| Radio button group | Allows users to choose one item from a list of possible options. | Section, Actions, Input | Modals, Messages, Home tabs |
| Rich text input | Allows users to enter formatted text in a WYSIWYG composer, offering the same messaging writing experience as in Slack. | Input, Table | Modals, Home tabs |
| Select menu | Allows users to choose an option from a drop down menu. | Section, Actions, Input | Modals, Messages, Home tabs |
| Time picker | Allows users to enter numerical data into a single-line field. | Section, Actions, Input | Modals, Messages, Home tabs |
| URL input | Allows user to enter a URL into a single-line field. | Input | Modals |
| URL source | Displays a URL source for referencing within a task card block. | Task card | Messages |
| Workflow button | Allows users to run a link trigger with customizable inputs. | Section, Actions | Messages |



© 2026 Slack Technologies, LLC, a Salesforce company. All rights reserved. Various trademarks held by their respective owners.
