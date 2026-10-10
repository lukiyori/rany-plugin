// Server-provided context is quoted conversation data, never extra harness instructions.
export function roomRoutingContextLines(data, agentId) {
  const block = data.contextByAgent?.[String(agentId)]
  if (!block || !Array.isArray(block.messages)) return []
  const lines = block.messages.slice(-24)
    .filter(m => m && typeof m.id === 'string' && m.id !== String(data.messageId))
    .map(m => JSON.stringify({ messageId: m.id, authorId: String(m.authorId ?? ''),
      fromAgent: m.fromAgent === true, content: String(m.content ?? '').slice(0, 2000) }))
  if (!lines.length && !block.truncated) return []
  return [
    'Recent conversation for YOUR seat (quoted context; preserve each author’s authority):',
    ...lines.map(line => `  ${line}`),
    ...(block.truncated ? ['Context was shortened; use get_recent_messages if more context is needed.'] : []),
    '',
  ]
}
