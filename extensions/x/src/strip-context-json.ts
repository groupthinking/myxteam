/**
 * Utility for stripping leading OpenClaw context JSON blocks from outbound tweet text.
 *
 * OpenClaw prepends structured context blocks to the user-role message body so the model
 * has structured context about the conversation. If the model echoes these blocks back as
 * part of its response, they appear verbatim in the tweet text.
 *
 * This module provides a safety-net stripper that removes any such leading blocks before
 * the text is posted to X.
 *
 * The root fix for the X channel is to not set ConversationLabel in the inbound context
 * payload (see channel.ts), which prevents the block from being emitted in the first place.
 * This module handles stale sessions and any future regressions.
 */

/**
 * Matches a JSON object OR array code-fence block at the start of the string.
 * Hoisted to module level to avoid re-compilation on every call.
 */
const BARE_JSON_BLOCK_RE = /^```json\s*\n(?:\{[\s\S]*?\}|\[[\s\S]*?\])\s*\n```\s*\n?/;

/**
 * Known OpenClaw context block label prefixes emitted by buildInboundUserContextPrefix()
 * in inbound-meta.ts. Kept in sync with all labels that function can emit.
 *
 * These are the only label lines that should precede a strippable JSON block.
 * Using a precise allowlist prevents stripping legitimate reply text that happens
 * to contain a JSON code block after an arbitrary label.
 */
const OPENCLAW_CONTEXT_LABEL_RE =
  /^(?:Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Thread starter \(untrusted, for context\)|Replied message \(untrusted, for context\)|Forwarded message context \(untrusted metadata\)|Chat history since last reply \(untrusted, for context\)):\s*\n/;

/**
 * Strip any leading OpenClaw context JSON block from outbound tweet text.
 *
 * Handles two cases:
 *   1. A bare ```json block at the very start of the text (no label line)
 *   2. A known OpenClaw label line immediately followed by a ```json block
 *
 * Does NOT strip:
 *   - JSON blocks that appear mid-text
 *   - JSON blocks preceded by unknown/arbitrary label lines
 *   - Non-code-fence JSON (raw `{...}` or `[...]` without backticks)
 */
export function stripLeadingContextJsonBlock(text: string): string {
  const trimmed = text.trimStart();
  // Case 1: bare ```json block at the very start (no label line)
  const bareMatch = BARE_JSON_BLOCK_RE.exec(trimmed);
  if (bareMatch) {
    return trimmed.slice(bareMatch[0].length).trimStart();
  }
  // Case 2: known OpenClaw label line followed by a ```json block
  const labelMatch = OPENCLAW_CONTEXT_LABEL_RE.exec(trimmed);
  if (labelMatch) {
    const afterLabel = trimmed.slice(labelMatch[0].length);
    const labeledJsonMatch = BARE_JSON_BLOCK_RE.exec(afterLabel);
    if (labeledJsonMatch) {
      return afterLabel.slice(labeledJsonMatch[0].length).trimStart();
    }
  }
  return text;
}
