/**
 * Which invite link in a prompt is the human's own, to join with (UserPromptSubmit).
 *
 * A pasted `/join-room/<code>` link joins the room by itself. But a prompt is not always typed by a human:
 * the plugin wakes a seated session by handing it the room's message as a prompt, and a room message can
 * QUOTE another seat's link. The hook joined that link too, so the owner reporting a bug about another seat
 * ("bu odada https://www.rany.work/join-room/… Yoda wakeup oldu ama …", 2026-11-25) moved that seat into the
 * terminal that read the report, and the reader lost its own seat (one seat per terminal). Both rooms went
 * quiet until someone rejoined by hand.
 *
 * Every wake the plugin writes starts a line with `RANY: `, and a background-task wake comes wrapped in
 * `<task-notification>`. A prompt carrying either is the plugin talking, not the human pasting: no join.
 */

/** A work-room invite link — or its bare `/join-room/<code>` path — anywhere in some text → its code. */
export function inviteCodeIn(text) {
  const m = /\/join-room\/([A-Za-z0-9]{8,64})\b/.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** True when the prompt is a wake or notification the plugin or the harness wrote, not the human's text. */
export function isRelayedPrompt(prompt) {
  const text = String(prompt ?? '')
  return /^\s*RANY: /m.test(text) || /<task-notification\b/i.test(text)
}

/** The invite code to join with, or null when the prompt has none or only quotes one inside a wake. */
export function inviteCodeToJoin(prompt) {
  return isRelayedPrompt(prompt) ? null : inviteCodeIn(prompt)
}
