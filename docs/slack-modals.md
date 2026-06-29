# Slack Modals — Key Reference

Source: https://docs.slack.dev/surfaces/modals/

---

## Payload types

| Event | When | Requires |
|---|---|---|
| `view_submission` | User clicks Submit | Always sent |
| `view_closed` | User clicks Cancel or × | `notify_on_close: true` on the view |

These are mutually exclusive — submission and dismissal are separate paths by design.

---

## notify_on_close

Set on the view at `views.open` / `views.push` time. Default is `false` — omitting it means `view_closed` is never sent.

```js
{
  type: 'modal',
  notify_on_close: true,
  ...
}
```

---

## is_cleared flag

Appears in `view_closed` when the user hits the **×** button (dismisses the entire modal stack). Cancel button sends `view_closed` without `is_cleared`. Both mean the same thing for this project: user abandoned the modal.

---

## private_metadata

- Passed at `views.open` / `views.push`; returned in `view_submission` and `block_actions` payloads
- Max 3 000 characters
- Not visible to the user
- Use it to carry `workflowRunId`, `traceId`, `callback`, and the originating action back to `handleViewSubmission` / `handleViewClosed`

---

## Modal stack

- Up to 3 views deep
- `views.push` / `response_action: "push"` — add a view on top
- `views.update` / `response_action: "update"` — replace the current view
- Each view retains its own state when another is pushed on top

---

## 3-second response window

`view_submission` responses must arrive within **3 seconds**. Response body controls what happens next:

| Response body | Effect |
|---|---|
| `200` with empty body | Close submitted view |
| `{"response_action": "clear"}` | Close all views |
| `{"response_action": "update", "view": {...}}` | Replace current view |
| `{"response_action": "push", "view": {...}}` | Push new view |
| `{"response_action": "errors", "errors": {...}}` | Show inline validation errors |

---

## Lifecycle constraints

- Apps **cannot programmatically close a modal** except in response to a `view_submission`. There is no API call to force-close a modal that a user has open.
- Users always retain independent control: Cancel and × are always available.
- `view_closed` is notification-only — Slack does not expect a specific response body.

---

## Implication for this project

`view_closed` (user cancels a modal opened from a human_gate) should result in **no workflow action** — the workflow stays suspended at the same gate, and the gate message remains active in Slack. Enqueuing `resume_gate` on `view_closed` is incorrect: it advances or cancels the workflow without user intent.

See `src/ui/slackbot/interactive.mjs` → `handleViewClosed`.
