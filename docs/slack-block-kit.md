# Slack Block Kit Reference

> Sources: https://docs.slack.dev/block-kit · https://api.slack.com/partners/thinking-steps  
> Examples captured from live Slack workspace — responses show actual payloads,
> not Block Kit Builder simulations. Block Kit Builder cannot simulate interactive
> responses (button clicks, form submissions) — those responses require a live app.
> Partner block types (see section below) are not available in Block Kit Builder.

---

## Concepts

Block Kit is built from three layers:

- **Blocks** — visual layout components (`section`, `actions`, `input`, `context`, `divider`, `header`, `image`, `markdown`, `carousel`)
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

**Limits:** at most **100 options** in total, and at most **100 `option_groups`**. An option's
`text` is capped at **75 characters**, its `value` at **150**, and its optional `description` at
**75**. Supply either `options` or `option_groups` — never both.

**`option_groups`** replaces `options` with an array of `{ label, options }`, each group rendering
under its own header inside the dropdown. This is the mechanism `list_selection` uses to keep two
child tables' rows visually and semantically distinct within one control (see design notes below).
On mobile Slack renders `static_select` as the native wheel picker.

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

**Used in evolving-mind-ai:** Novia (minds-eye agent) replies always set `format: 'markdown'` on the `HUMAN_NOTIFICATION` callback payload; `notify` steps in generated workflows (Sprint 7 Track D1) do the same via `run-workflow.mjs`. Both route to `markdownToBlocks()` in `callback.mjs` and emit `{ type: 'markdown', text }` blocks. `dialogToBlocks()`'s `typography` and `description_list` fields also emit `markdown` blocks (Sprint 7 D1), as does `postHumanGate`'s `text_input` branch.

**Supported syntax** (verified against docs.slack.dev/reference/block-kit/blocks/markdown-block, 2026-07-05): bold, italic, strikethrough, inline code, bold+italic, links, unordered/ordered lists, task lists (`- [ ]` / `- [x]`), **headers at all levels (`#`–`######`)**, block quotes, fenced code blocks with syntax highlighting, dividers (`---`), and standard markdown tables. Images are **not embedded** — rendered as a link instead.

**Known doc/live-rendering discrepancy (found 2026-07-06, not yet reconciled):** the Slack docs text says *"all header levels are rendered at the same size"* — but a live render of a single `markdown` block containing `#` through `######` in sequence showed `#`/`##`/`###` each at a visibly distinct size, while `####`/`#####`/`######` collapsed to one shared size (matching `###` or close to it — not independently confirmed which). So the "no size hierarchy" quirk is real but narrower than the docs state: it appears to kick in only at H4 and deeper, not from H1. Not re-verified beyond one live test; see backlog for follow-up. Until reconciled, don't rely on `####`+ for any intended visual distinction within a `markdown` block.

**This quirk is specific to `#` syntax inside a `markdown` block.** It does not apply to the separate `header` block type below, which has a real `level` field (though `header.level` is documented as capped at 4 — H1-H4 — so a source document using `#`-`######` still needs a level-capping decision somewhere if translated to `header` blocks; see this project's `markdownToBlocks()` splitter, which caps at `level: 4`).

---

## Header block

`type: "header"` — a distinct Block Kit block, not a markdown-syntax feature. Unlike the `markdown` block's inline `#` headers (same visual size at every level, see above), `header` blocks genuinely render at different sizes via a `level` field.

**Fields** (verified against docs.slack.dev/reference/block-kit/blocks/header-block, 2026-07-06):

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | Yes | Always `"header"` |
| `text` | object | Yes | `{ type: "plain_text", text, emoji? }` — **`plain_text` only**, no `mrkdwn`/`markdown` object type accepted, so no bold/italic/links inside a header's own text |
| `block_id` | string | No | |
| `level` | integer | No | 1–4, corresponding to H1–H4. Omitted = a default level (not H1–specific per docs; verify visually if exact default sizing matters) |

```json
{
  "type": "header",
  "text": { "type": "plain_text", "text": "Spanish Vocabulary", "emoji": true },
  "level": 1
}
```

**Not used in evolving-mind-ai yet.** Candidate use: rendering genuine visual
hierarchy (root entity vs. child records) for `format_entity_display` (Sprint 7
Track D2) — would require a harness step that splits an LLM's plain markdown
`#`/`##`/`###` output into alternating `header` (per heading line, `level =
min(#-count, 4)`) and `markdown` (body text between headings) blocks, since the
LLM's job is to produce standard markdown, not hand-assemble Block Kit JSON
(same extend-the-harness-not-the-prompt principle as everywhere else in this
project). Not yet implemented.

**Limit:** the cumulative limit for all `markdown` blocks in a single payload is **12,000 characters** (separate from the 2800-char-per-block chunking already used by `markdownToBlocks`, and separate from the 50-block-per-message limit). `postHumanNotification`'s `groupBlocksForSlack()` helper (Sprint 7) splits content into multiple Slack messages when either the block-count limit or this cumulative markdown-char limit would be exceeded — added because a long Novia reply or generated report could otherwise silently fail to post.

**Architecture note:** `/proc` and `/serv` are the transport-agnostic layers of this system — prompts and system context that describe formatting (e.g. `PGC_SystemContext.markdown_formatting_syntax`) describe *standard markdown* generically, with no mention of Slack. Translating that markdown to whatever a specific surface needs is `/ui/slackbot`'s job (`callback.mjs`). Since Slack's `markdown` block already accepts near-full CommonMark natively, that translation is currently a pass-through (`markdownToBlocks` sends the text as-is) — no per-syntax-element conversion is needed today.

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
| Headers | Not supported (use bold instead) | `#`–`######` (all render at the same size) |
| Task list | Not supported | `- [ ] item` / `- [x] item` |
| Divider | Not supported inline (use a `divider` block) | `---` |
| Image | `<url\|text>` as a link only | Not embedded — rendered as a link |

---

## Partner block types

Non-standard blocks from the Slack partner API. Not available in Block Kit Builder — test
only in a live workspace. Source: https://api.slack.com/partners/thinking-steps

### `task_card`

An inline accordion that renders a collapsible task result — title, optional details, and
output — directly in a message or thread without opening a modal. Designed for streaming
AI "thinking steps" but usable for any reveal-style content.

**Not currently used in evolving-mind-ai** — the `reveal`/`reveals` gate field rendered
inline panels with this block type through Sprint 7, superseded by `container` (see below),
which finally supports markdown content. Kept here as reference for `task_card`'s original
"streaming AI thinking steps" use case (a live `status: "in_progress"` spinner), which
`container` cannot replicate.

#### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"task_card"` | Yes | Block type discriminator |
| `task_id` | UUID string | Yes | Unique per card; generate with `randomUUID()` |
| `title` | string | Yes | Heading shown collapsed and expanded |
| `status` | string | Yes | `"in_progress"` (spinner) or `"complete"` |
| `details` | rich_text | No | Body content — supports `rich_text_list` (bullet/ordered lists), `rich_text_section`, links, emoji. Use for structured or list content. |
| `output` | rich_text | No | Secondary body content — supports `rich_text_section` (plain text and links). Renders below `details` if both are present. Use for plain prose only. |

**Use `details` (not `output`) whenever the content is a list of items.** `output` supports only flat `rich_text_section` elements. `details` supports `rich_text_list` with `style: "bullet"` or `"ordered"`, which is required for tree-leaf presentation (parent title → bulleted children).

**`task_card` never interprets markdown syntax, in either `details` or `output` (confirmed live 2026-07-06, Sprint 7 Track D2).** `rich_text` elements are structural, not markdown text — a `rich_text_section`'s `{ type: "text", text }` renders that string completely literally: `**bold**` shows as literal asterisks, `#` headings show as literal hash marks, and a scalar `output` string containing embedded `\n` line breaks does not reliably render as separate visual lines. The *only* way to get one bullet per item is to pass `content` as an **array** — `buildRevealBlock()` (`callback.mjs`) only builds a `rich_text_list` (one `rich_text_section`/bullet per array entry) when `Array.isArray(field.content)`; a single string, however formatted, always renders as one `output` blob. `format_entity_display`'s `reveals[].content` was originally specified as a markdown string (wrong assumption, not verified before shipping) and produced exactly this failure — one bullet containing an entire raw block of `1. **X** -- Y\n2. **Z**...` text; fixed (prompt v3) to require an array of plain-text lines instead.

#### Example — plain text reveal (current `output` usage)

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

#### Example — tree-leaf reveal using `details` + `rich_text_list`

Use this pattern for one-level-deep hierarchies (parent node title → bulleted child items).
`status: "complete"` — data is pre-loaded, no spinner needed.

```json
{
  "type": "task_card",
  "task_id": "985d975c-3bee-449c-b27b-977a1b5e06e6",
  "title": "Spanish Vocabulary",
  "status": "complete",
  "details": {
    "type": "rich_text",
    "elements": [
      {
        "type": "rich_text_list",
        "style": "bullet",
        "indent": 0,
        "elements": [
          {
            "type": "rich_text_section",
            "elements": [{ "type": "text", "text": "Basic Phrases" }]
          },
          {
            "type": "rich_text_section",
            "elements": [{ "type": "text", "text": "Food & Drink" }]
          },
          {
            "type": "rich_text_section",
            "elements": [{ "type": "text", "text": "Numbers & Time" }]
          }
        ]
      }
    ]
  }
}
```

`rich_text_list` elements: each `rich_text_section` is one bullet. Elements within a section
can mix `text`, `link`, and `emoji` inline — the full rich_text inline element set applies.

#### Example — mixed intro text + bullet list in `details`

```json
{
  "type": "task_card",
  "task_id": "985d975c-3bee-449c-b27b-977a1b5e06e6",
  "title": "Parent Node",
  "status": "complete",
  "details": {
    "type": "rich_text",
    "elements": [
      {
        "type": "rich_text_section",
        "elements": [{ "type": "text", "text": "Select a child item:\n" }]
      },
      {
        "type": "rich_text_list",
        "style": "bullet",
        "indent": 0,
        "elements": [
          {
            "type": "rich_text_section",
            "elements": [{ "type": "text", "text": "Child Item 1" }]
          },
          {
            "type": "rich_text_section",
            "elements": [
              { "type": "text", "text": "Child Item 2 — " },
              { "type": "link", "url": "https://example.com/", "text": "with a link", "style": { "bold": true } }
            ]
          },
          {
            "type": "rich_text_section",
            "elements": [
              { "type": "text", "text": "Child Item 3 " },
              { "type": "emoji", "name": "white_check_mark" }
            ]
          }
        ]
      }
    ]
  }
}
```

**Notes:**
- Both `details` and `output` use `rich_text` format — not `mrkdwn`.
- `details` is the correct field for any list content. `output` is plain prose only.
- Post via `chat.postMessage`, not `views.open` — no `trigger_id` required.
- `rich_text_list` supports `style: "bullet"` or `style: "ordered"` and optional `indent` (0-based nesting depth).

---

## Standard block types

Blocks documented on Slack's main Block Kit reference (`docs.slack.dev/reference/block-kit/blocks/`) —
distinct from the `Partner block types` above, which come from the separate partner API reference.

### `container`

A collapsible card block — source: `https://docs.slack.dev/reference/block-kit/blocks/container-block/`
(fetched 2026-07-09). Renders a titled panel that can collapse to just its title, expanding to
reveal a list of nested `child_blocks`.

**Usage in evolving-mind-ai:** the `reveal`/`reveals` gate field. `buildRevealBlock()`
(`callback.mjs`) renders every reveal as a `container` — replaces `task_card` (above), which
could never interpret markdown. A container's child blocks are ordinary `section`/`mrkdwn`
blocks, so reveal content finally supports real markdown formatting.

#### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"container"` | Yes | Block type discriminator |
| `title` | text object (`plain_text`) | Yes | Max 150 characters |
| `child_blocks` | array | Yes | Max **10** blocks |
| `block_id` | string | No | Auto-generated if omitted |
| `subtitle` | text object (`plain_text` or `mrkdwn`) | No | Max 150 characters |
| `icon` | image element | No | Max 3000 characters |
| `width` | `"narrow"` \| `"standard"` \| `"wide"` \| `"full"` | No | Default `"standard"` |
| `rich_text_title` | rich text object | One of `title`/`rich_text_title` | Takes precedence when both are given |
| `has_header_divider` | boolean | No | Default `false`; non-collapsible containers only |
| `is_collapsible` | boolean | No | Default `false` |
| `default_collapsed` | boolean | No | Only takes effect when `is_collapsible: true` |

**Allowed `child_blocks` types (max 10):** `actions`, `context`, `divider`, `file`, `header`,
`image`, `input`, `rich_text`, `section`, `table`, `video`. **The top-level `markdown` block
type is not on this list** — inside a container, use `section` with `mrkdwn` text for
prose/markdown content instead.

#### Example — reveal panel (evolving-mind-ai usage)

```json
{
  "type": "container",
  "block_id": "reveal_bb9cb0c7-bf08-4eed-9e44-3ee71ef021a6",
  "title": { "type": "plain_text", "text": "PGD_ReviewLog (7)" },
  "is_collapsible": true,
  "default_collapsed": true,
  "child_blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "• *Grade:* 4 · *Review Date:* Jun 28, 2026\n• *Grade:* 2 · *Review Date:* Jul 3, 2026" }
    }
  ]
}
```

**`buildRevealBlock()` behavior:** `content` is a plain string → the section's text directly; an
array of strings, or an array of objects uniformly shaped with `syntax`/`verb`/`command` → one
`• ` bullet per line in a single `mrkdwn` string, chunked into additional `section` blocks past
~2800 characters (Slack's per-`section` text limit is 3000), capped at the 10-`child_blocks`
ceiling, with any remainder summarized as `_...and N more chunk(s)_` on the last kept block; an
array of plain record objects (any other shape) → one or more native `table` blocks instead — see
`table` below, since neither `mrkdwn` nor `container.child_blocks` can render markdown table
syntax, and a table taller than the container's visible-row clip is chunked across several blocks.

**Not yet independently live-verified in evolving-mind-ai** — implemented from the official
reference; same "verify live before fully trusting" caveat this doc applies to `carousel`.

### `table`

A native grid/table block — source: `https://docs.slack.dev/reference/block-kit/blocks/table-block/`
(fetched 2026-07-09). Renders real tabular data as rows of cell objects — not markdown pipe-table
syntax, which neither `mrkdwn` nor `container.child_blocks` can render (see `container` above,
"Allowed `child_blocks` types"). `table` is the *only* way to render a real grid inside a
`container` — the top-level `markdown` block type, which does support markdown tables, is
explicitly excluded from `container.child_blocks`.

**Usage in evolving-mind-ai:** `buildRevealBlock()` (`callback.mjs`) renders a `table` block via
`buildTableBlock()` for two distinct `reveal`/`reveals` `content` shapes:
- an array of plain record objects (no `syntax`/`verb`/`command` field — that shape still renders
  as bullets) — via `buildRevealTable()`, columns are the union of every item's own keys,
  first-seen order, labeled via the same `formatColumnHeader()` used by `list_selection`'s
  markdown table (see "list gate rendering" below);
- a **string** containing a markdown pipe-table (e.g. a js_transform building
  `"| Deck | Cards |\n|---|---|\n| ... |"` directly, common before this capability existed) — via
  `splitMarkdownTableSegments()`, which parses the string into alternating text/table segments so
  the table renders natively while any surrounding prose stays as ordinary `section`/`mrkdwn`
  blocks, chunked by `chunkTextBlocks()`. This split is specific to reveal panels — markdown
  tables in a top-level `markdown` block (`list_selection`, prose responses) already render
  correctly as-is and need no such parsing.

Both paths share `buildTableBlock()` for the actual `table` block construction, just a different
Block Kit primitive because the surrounding block type differs from other markdown contexts.

#### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"table"` | Yes | Block type discriminator |
| `rows` | array of arrays of cell objects | Yes | Max **100** rows (including header row), max **20** cells per row |
| `column_settings` | array | No | Max 20 entries — `{ align: "left" \| "center" \| "right", is_wrapped: boolean }` per column |
| `block_id` | string | No | Max 255 characters |

**Cell types:** `raw_text` (`{ type: "raw_text", text }`), `raw_number`, or `rich_text` (full
rich-text formatting — bold, emoji, mentions, links). **`raw_text` cells do not render as a grid
— confirmed live 2026-07-09: Slack falls back to a flattened, pipe-joined text representation.**
`buildRevealTable()` uses `rich_text` cells (one `rich_text_section` wrapping one `text` element),
with `style: { bold: true }` on header-row cells.

**Limits:** 100 rows, 20 columns, and an aggregate **10,000 characters** across all cell text —
per **message**, not per table: *"the aggregate character count across all table cells for a single
message cannot exceed 10,000 characters"*. A gate carrying several reveals shares one budget, so
`buildRevealBlock()` threads a budget object created once per message (`makeTableBudget()`) rather
than resetting it per table. Columns beyond 20 are silently dropped; rows beyond the row,
character or child-block ceiling truncate with a trailing `_...and N more row(s)_` `section`.

**Vertical clipping inside a container — measured, not documented.** A `table` inside a reveal
renders **8 rows** and clips the rest, with no vertical scroll: rows past the eighth cannot be
reached at all. Observed on run 779 (35 receipt items, 7 visible beneath the header). Slack
documents no height, scroll, or overflow behaviour for either the `table` or the `container`
block, so this is an observation about the client, not a published limit — treat it as liable to
change and re-verify if reveal rendering ever looks wrong again.

`buildRevealTables()` chunks one logical table into as many `table` blocks as it takes for every
row to be reachable: at most 8 rows per block, the header carried by the first chunk only (a
repeated header would cost one data row per chunk, and the chunks render adjacently inside one
panel). A `table` block ascribes no meaning to its first row — a header reads as one because its
cells are bold — so a continuation chunk carrying only data is valid. Chunking is bounded by the
container's 10-child-block ceiling, so it does not rescue an arbitrarily long table; past that,
the remainder is reported rather than silently dropped.

#### Example — reveal panel rendered as a table (evolving-mind-ai usage)

```json
{
  "type": "container",
  "block_id": "reveal_bb9cb0c7-bf08-4eed-9e44-3ee71ef021a6",
  "title": { "type": "plain_text", "text": "Child Decks" },
  "is_collapsible": true,
  "default_collapsed": true,
  "child_blocks": [
    {
      "type": "table",
      "rows": [
        [
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Title", "style": { "bold": true } }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Card Count", "style": { "bold": true } }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Due Count", "style": { "bold": true } }] }] }
        ],
        [
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Spanish Vocabulary" }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "42" }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "5" }] }] }
        ]
      ]
    }
  ]
}
```

**Live-verified in evolving-mind-ai (2026-07-09)** — the `raw_text` cell variant tried first did
not render as a grid (fell back to flattened pipe-joined text); `rich_text` cells confirmed
working against a real Slack workspace.

### `carousel`

A horizontally-scrollable row of `card` elements — image, title, subtitle, body text, and
action buttons per card. Suited to a set of source links or reference items alongside a
`markdown` body block. **Not yet used in evolving-mind-ai** — documented here from a
user-provided example for future reference; not independently verified against official docs
the way `task_card` and the `markdown` block limits above were.

#### Fields (per `card` element)

| Field | Type | Description |
|---|---|---|
| `type` | `"card"` | Element type discriminator |
| `block_id` | string | Unique id for the card |
| `hero_image` | image object | `{ type: "image", image_url, alt_text }` — shown at the top of the card |
| `title` | text object | Typically `{ type: "mrkdwn", text, verbatim }` |
| `subtitle` | text object | Same shape as `title` — shown below it |
| `body` | text object | Same shape — main card text |
| `actions` | array of `button` | Standard button elements; a `url` field opens a link directly with no `action_id` round-trip needed |

#### Example — three source cards alongside a markdown body

```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "Your deep dive is ready 🌕" }
    },
    {
      "type": "markdown",
      "text": "## Report Title\n\nBody content with **bold**, tables, and lists.\n\n> A summary blockquote."
    },
    {
      "type": "carousel",
      "elements": [
        {
          "type": "card",
          "block_id": "source-1",
          "hero_image": { "type": "image", "image_url": "https://example.com/image.jpg", "alt_text": "..." },
          "title": { "type": "mrkdwn", "text": "Source Title", "verbatim": false },
          "subtitle": { "type": "mrkdwn", "text": "example.com", "verbatim": false },
          "body": { "type": "mrkdwn", "text": "One-line summary of the source.", "verbatim": false },
          "actions": [
            {
              "type": "button",
              "text": { "type": "plain_text", "text": "Read", "emoji": false },
              "url": "https://example.com/article",
              "action_id": "read_source_1"
            }
          ]
        }
      ]
    },
    {
      "type": "context",
      "elements": [{ "type": "mrkdwn", "text": "This report was generated by AI. Verify important details before sharing or taking action." }]
    }
  ]
}
```

Note the mixed pattern: a `section`/`mrkdwn` teaser, a `markdown` body block for the rich
content, a `carousel` for reference cards, and a `context` disclaimer footer — all in one
message.

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

### form gate rendering

One Slack `input` block per declared field. `buildInputElement()` in `callback.mjs` is the
**only** place a UI-agnostic field type becomes a Slack element — `/proc` says `date`, this
decides that means a `datepicker`. Adding a widget is one row here and nothing in `/proc`.

| Field type | Slack element |
|---|---|
| `text` / `textarea` | `plain_text_input` (`multiline` for textarea) |
| `select` | `static_select` (≤100 options) |
| `multi_select` | `multi_static_select` (≤100) |
| `radio` | `radio_buttons` (≤10) |
| `checkbox` | `checkboxes` (≤10) |
| `date` | `datepicker` |
| `time` | `timepicker` |
| `datetime` | `datetimepicker` |

Every one of these works in a **message**. `number_input`, `email_input`, `url_input` and
`file_input` are **modal-only** and so are deliberately not offered as field types.

Each block's `block_id` is `form_field_<runId>::<fieldName>`. The `::` separator matters —
field names may contain underscores, so an underscore-delimited id could not be split back
into a name reliably. `form-fields.mjs` owns both the prefix and the parser, shared by
`callback.mjs` (which writes the id) and `interactive.mjs` (which reads it), so the two
cannot drift.

On submit, Slack returns every field at once in `state.values`; `collectFormValues()`
rebuilds them into `{ fieldName: value }`. Each element reports its answer under a different
key (`value`, `selected_option`, `selected_options`, `selected_date`, `selected_time`), which
`extractFieldValue()` normalises.

**Slack does not validate a message's inputs.** The `optional` flag is enforced only on
*modal* submit — clicking Submit on a message posts whatever is there, gaps included. Required
fields are therefore re-checked in `resumeGate`, which re-renders the gate rather than
advancing. That re-render posts a **new** message rather than editing in place: `chat.update`
is unreliable on messages carrying input blocks, and a silently-dropped edit would be
indistinguishable from a hang.

### list_selection gate rendering

`callback.mjs` renders the rows themselves as one `markdown` table (uncapped — Slack scrolls
long tables natively), then one shared selection control plus one Select button below it.

The control is a `static_select` built by `buildListSelect()`. Its options carry a JSON
`{id, table}` value rather than a bare id, so when one drill-down level spans more than one
child table (a recipe's ingredients *and* its steps), each table becomes its own labeled
`option_groups` entry and an id that exists in both resolves unambiguously — the source table
travels with the selection instead of being guessed at afterwards.

The relevant Slack limits (see the element reference sections above): **100 options** across all
groups, option `text` **75 characters**, option `value` **150 characters**. Past the option cap
`buildListSelect()` returns `null` and the gate falls back to the original shared
`plain_text_input`, where the user types a bare id and a cross-table collision resolves
first-hit. The table is unaffected either way, so no row is ever hidden.

Radio buttons (10 options), checkboxes (10) and the overflow menu (5) were all considered and
are capped far too low for a record list of any real size.

### reveal gate rendering

`callback.mjs` renders every `reveal`/`reveals` field as a `container` block (see `container`
above) — replaces the earlier `task_card` implementation, which could never interpret markdown.
`buildRevealBlock()` picks one of two rendering paths for the content: a plain string or an
array of strings (or `syntax`/`verb`/`command`-shaped objects) becomes one or more
`section`/`mrkdwn` child blocks, chunked past ~2800 characters and capped at the container's
10-`child_blocks` limit; an array of plain record objects becomes a single native `table` block
(see `table` above) — the only way to render a real grid inside a `container`, since neither
`mrkdwn` nor `container.child_blocks` support markdown table syntax.

Set `title` from `button_label`, `is_collapsible: true`, `default_collapsed: true` — reveals are
progressive disclosure, collapsed until the user expands them. Renders inline in the same
message, same as `task_card` did — no `trigger_id` needed, no click required to see the panel
exists (only to expand it).

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
