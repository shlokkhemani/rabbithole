export function writeSseEvent(res, event) {
  if (!event.wire) event.wire = `id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`;
  res.write(event.wire);
}
