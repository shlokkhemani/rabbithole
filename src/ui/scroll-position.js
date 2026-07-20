function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scrollRange(scroller) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function captureContentPosition(scroller) {
  if (!scroller) return null;
  var range = scrollRange(scroller);
  var position = { progress: range ? scroller.scrollTop / range : 0, block: -1, offset: 0 };
  var content = scroller.querySelector?.(".doc-content");
  if (!content) return position;
  var viewportTop = scroller.getBoundingClientRect().top;
  var blocks = Array.from(content.children);
  for (var i = 0; i < blocks.length; i++) {
    var rect = blocks[i].getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      position.block = i;
      position.offset = (viewportTop - rect.top) / Math.max(1, rect.height);
      break;
    }
  }
  return position;
}

export function restoreContentPosition(scroller, position) {
  if (!scroller || !position) return;
  var range = scrollRange(scroller);
  var content = scroller.querySelector?.(".doc-content");
  var block = content && position.block >= 0 ? content.children[position.block] : null;
  if (block) {
    var scrollerRect = scroller.getBoundingClientRect();
    var viewportTop = scrollerRect.top;
    var rect = block.getBoundingClientRect();
    var targetTop = rect.top + clamp(position.offset, -1, 1) * rect.height;
    var visualScale = scroller.offsetHeight ? scrollerRect.height / scroller.offsetHeight : 1;
    scroller.scrollTop = clamp(scroller.scrollTop + (targetTop - viewportTop) / (visualScale || 1), 0, range);
    return;
  }
  scroller.scrollTop = clamp((Number(position.progress) || 0) * range, 0, range);
}
