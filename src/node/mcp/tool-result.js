export function formatToolSuccess(tool, result) {
  if (tool.explicitContent) return result;
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
