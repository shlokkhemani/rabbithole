import { normalizePdfExtension } from "../core/pdf-shared.js";
import { iconSvg } from "../core/html/icons.js";
import { childrenOf, postBrowserEvent } from "./core.js";
import { showAskFromSelection } from "./ask-followups.js";
import { mountPdfRectMark } from "./text-marks.js";
import { acquirePdfDocument, pdfAnnotationModeDisabled, pdfShowTextOpcode, renderPdfTextLayer, updatePdfTextLayer } from "./pdf-runtime.js";
import { resolveAssetUrl } from "./renderer.js";

const TILE_PIXELS = 1536;
const FULL_PAGE_PIXELS = 12 * 1024 * 1024;
const READER_DEFAULT_PAGE_WIDTH = 642;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const textMeasureCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
const textMeasureContext = textMeasureCanvas?.getContext("2d") || null;

export function mountPdfView(container, node, options = {}) {
  const pdf = normalizePdfExtension(node);
  const rawPdf = node?.extensions?.pdf;
  if (!pdf || pdf.converted || pdf.converting) {
    if (rawPdf?.version === 1 && !rawPdf.converted) mountLegacyNotice(container);
    return null;
  }

  container.className = "doc-content rh-pdf";
  const isReaderSurface = container.dataset.surface === "reader";
  const toolbar = createToolbar(pdf, node, { reader: isReaderSurface });
  // Document content is mounted while detached, so its explicit surface tag
  // is the reliable boundary between Reader chrome and a canvas card.
  const readerToolbarHost = isReaderSurface && document.getElementById("tb-document");
  const scroll = document.createElement("div");
  scroll.className = "rh-pdf-scroll";
  scroll.dataset.zoom = "1";
  const stack = document.createElement("div");
  stack.className = "rh-pdf-stack";
  scroll.appendChild(stack);
  if (readerToolbarHost) {
    toolbar.element.classList.add("rh-pdf-reader-toolbar", "tb-pill");
    toolbar.element.dataset.pdfNodeId = node.id;
    toolbar.element.setAttribute("aria-label", "PDF reader controls");
    readerToolbarHost.replaceChildren(toolbar.element);
    container._rhPdfToolbarElement = toolbar.element;
    container.replaceChildren(scroll);
  } else {
    container.replaceChildren(toolbar.element, scroll);
  }
  syncPdfTranscriptionControls(container, options.getTranscriptionCapability?.());

  let disposed = false;
  let documentLease = null;
  let documentProxy = null;
  let documentReady = null;
  let localZoom = 1;
  let boxMode = false;
  let frame = 0;
  let zoomFrame = 0;
  let pendingZoomAnchor = null;
  let textGesture = null;
  let intersectionObserver = null;
  let resizeObserver = null;
  let touchCleanup = () => {};
  const pageStates = [];
  const visiblePages = new Set();

  function alignReaderToolbar() {
    if (!readerToolbarHost || !scroll.isConnected) return;
    const rect = scroll.getBoundingClientRect();
    const desired = rect.left + scroll.clientWidth / 2;
    const toolbarWidth = toolbar.element.getBoundingClientRect().width;
    const tools = document.getElementById("tb-tools")?.getBoundingClientRect();
    const session = document.getElementById("tb-session")?.getBoundingClientRect();
    const half = toolbarWidth / 2;
    const minimum = tools ? tools.right + 8 + half : desired;
    const maximum = session ? session.left - 8 - half : desired;
    const center = minimum <= maximum ? Math.min(maximum, Math.max(minimum, desired)) : desired;
    if (Number.isFinite(center)) readerToolbarHost.style.setProperty("--rh-pdf-reader-center", `${center}px`);
  }

  toolbar.onZoom((factor, anchor) => setZoom(factor, anchor));
  toolbar.onBoxMode((active) => {
    boxMode = active;
    container.classList.toggle("rh-pdf-box-mode", active);
  });

  function setZoom(next, anchor = null) {
    const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next) || 1));
    if (Math.abs(value - localZoom) < 0.0001) return;
    const pinned = anchor && pdfPointAtClient(anchor.x, anchor.y);
    localZoom = value;
    toolbar.setZoom(localZoom);
    pendingZoomAnchor = pinned ? { pinned, x: anchor.x, y: anchor.y } : null;
    if (zoomFrame) return;
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = 0;
      const restore = pendingZoomAnchor;
      pendingZoomAnchor = null;
      updatePageLayouts();
      scroll.dataset.zoom = String(localZoom);
      if (restore) restoreClientAnchor(restore.pinned, restore.x, restore.y);
      scheduleRender();
    });
  }

  function fitScaleFor(page) {
    const base = page.getViewport({ scale: 1, rotation: page.rotate });
    const viewportWidth = Math.max(240, scroll.clientWidth - 28);
    // Reader owns the whole viewport, but 100% remains a comfortable paper
    // size. Local zoom can then consume the side margins before it needs a
    // horizontal scroll range. Canvas PDFs continue fitting their card width.
    const available = isReaderSurface ? Math.min(READER_DEFAULT_PAGE_WIDTH, viewportWidth) : viewportWidth;
    return Math.min(1.5, available / base.width);
  }

  function updatePageLayouts() {
    for (const state of pageStates) {
      if (!state.page) continue;
      state.displayScale = fitScaleFor(state.page) * localZoom;
      state.viewport = state.page.getViewport({ scale: state.displayScale, rotation: state.page.rotate });
      state.element._pdfViewport = state.viewport;
      state.element.style.width = `${state.viewport.width}px`;
      state.element.style.height = `${state.viewport.height}px`;
      scaleCanvasGenerations(state);
      positionRegionDraft(state);
      state.marks.setAttribute("viewBox", `0 0 ${state.viewport.width} ${state.viewport.height}`);
      state.marks.setAttribute("width", String(state.viewport.width));
      state.marks.setAttribute("height", String(state.viewport.height));
      void renderText(state);
    }
    refreshAllMarks();
    alignReaderToolbar();
  }

  function scheduleRender() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const state of pageStates) {
        if (visiblePages.has(state) || state === pageStates[0]) void renderPageTiles(state);
      }
    });
  }

  async function ensurePage(state) {
    if (state.page) return state.page;
    if (!documentProxy) await documentReady;
    if (disposed || !documentProxy) return null;
    state.page = await documentProxy.getPage(state.meta.n);
    state.displayScale = fitScaleFor(state.page) * localZoom;
    state.viewport = state.page.getViewport({ scale: state.displayScale, rotation: state.page.rotate });
    state.element._pdfViewport = state.viewport;
    state.element.style.width = `${state.viewport.width}px`;
    state.element.style.height = `${state.viewport.height}px`;
    scaleCanvasGenerations(state);
    positionRegionDraft(state);
    state.marks.setAttribute("viewBox", `0 0 ${state.viewport.width} ${state.viewport.height}`);
    state.marks.setAttribute("width", String(state.viewport.width));
    state.marks.setAttribute("height", String(state.viewport.height));
    await renderText(state);
    refreshAllMarks();
    return state.page;
  }

  async function renderText(state) {
    if (!state.page || !state.viewport || disposed) return;
    const key = `${state.viewport.scale}:${state.viewport.rotation}`;
    if (state.textKey === key) return;
    state.textLayer.style.setProperty("--scale-factor", String(state.viewport.scale));
    if (state.textKey && state.textDivs.length && state.textProperties) {
      // PDF.js can reproject the existing spans. Keeping the same DOM nodes
      // avoids a full text-layer rebuild on every zoom and preserves an active
      // native selection while its geometry changes.
      updatePdfTextLayer({
        container: state.textLayer,
        viewport: state.viewport,
        textDivs: state.textDivs,
        textDivProperties: state.textProperties,
      });
      tuneTextLayerSpacing(state.textDivs, state.textItems, state.textStyles, state.textProperties, state.viewport);
      state.textKey = key;
      return;
    }
    const generation = ++state.textGeneration;
    state.textTask?.cancel?.();
    state.textTask = null;
    state.textLayer.replaceChildren();
    const [content, operatorList] = await Promise.all([
      state.textContent || (state.textContentPromise ||= state.page.getTextContent({ includeMarkedContent: true })),
      state.operatorListPromise ||= state.page.getOperatorList(),
    ]);
    if (disposed || state.textGeneration !== generation) return;
    state.textContent = content;
    state.textItems = content.items.filter((item) => typeof item?.str === "string");
    state.textStyles = content.styles || {};
    state.textMetrics = exactTextItemMetrics(state.textItems, operatorList, pdfShowTextOpcode());
    await useEmbeddedTextLayerFonts(state.page, state.textItems, state.textStyles);
    if (disposed || state.textGeneration !== generation) return;
    state.textDivs = [];
    state.textProperties = new WeakMap();
    const task = renderPdfTextLayer({
      textContentSource: content,
      container: state.textLayer,
      viewport: state.viewport,
      textDivs: state.textDivs,
      textDivProperties: state.textProperties,
      textContentItemsStr: [],
    });
    state.textTask = task;
    try { await task.promise; } catch (error) { if (error?.name !== "AbortException") throw error; }
    if (disposed || state.textGeneration !== generation || state.textTask !== task) return;
    tuneTextLayerSpacing(state.textDivs, state.textItems, state.textStyles, state.textProperties, state.viewport);
    let itemIndex = 0;
    for (const span of state.textDivs) {
      span.dataset.pdfItem = String(itemIndex++);
    }
    state.textKey = key;
    state.textTask = null;
  }

  async function renderPageTiles(state) {
    const page = await ensurePage(state);
    if (!page || disposed || !state.viewport || !state.element.isConnected) return;
    const pageRect = state.element.getBoundingClientRect();
    if (!(pageRect.width > 0 && pageRect.height > 0)) return;
    const screenScale = pageRect.width / state.viewport.width;
    const outputScale = Math.max(1, screenScale * (devicePixelRatio || 1));
    const renderScale = state.displayScale * outputScale;
    const renderViewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
    const desired = desiredTiles(state, renderViewport, outputScale, pageRect);
    const scaleKey = renderScale.toFixed(5);
    const desiredKeys = desired.map(tileKey);
    const key = `${scaleKey}:${desiredKeys.join(";")}`;
    if (state.renderKey === key) return;
    state.renderKey = key;
    cancelRenderTasks(state);
    const current = state.canvasLayer.querySelector(".rh-pdf-canvas-generation[data-ready='true']");
    if (current?.dataset.renderScale === scaleKey) {
      const existing = new Set([...current.querySelectorAll("canvas[data-tile]")].map((canvas) => canvas.dataset.tile));
      const missing = desired.filter((tile, index) => !existing.has(desiredKeys[index]));
      if (missing.length) {
        const canvases = await renderTiles(state, page, renderViewport, outputScale, missing, key);
        if (!canvases) return;
        if (disposed || state.renderKey !== key || !current.isConnected) { releaseCanvases(canvases); return; }
        current.append(...canvases);
      }
      // The desired set already includes a one-tile reading buffer. Reusing
      // overlapping tiles makes high-zoom scrolling incremental while this
      // trim keeps GPU memory bounded.
      const retained = new Set(desiredKeys);
      for (const canvas of current.querySelectorAll("canvas[data-tile]")) {
        if (!retained.has(canvas.dataset.tile)) releaseCanvas(canvas);
      }
      return;
    }
    const generation = document.createElement("div");
    generation.className = "rh-pdf-canvas-generation";
    generation.dataset.renderScale = scaleKey;
    generation.dataset.viewportWidth = String(state.viewport.width);
    generation.dataset.viewportHeight = String(state.viewport.height);
    generation.style.width = `${state.viewport.width}px`;
    generation.style.height = `${state.viewport.height}px`;
    generation.style.right = "auto";
    generation.style.bottom = "auto";
    const canvases = await renderTiles(state, page, renderViewport, outputScale, desired, key);
    if (!canvases) { releaseGeneration(generation); return; }
    generation.append(...canvases);
    if (disposed || state.renderKey !== key) { releaseGeneration(generation); return; }
    // Keep the readable pixels mounted until their complete replacement is
    // ready. DOM updates paint atomically, so zoom never exposes a white frame.
    generation.dataset.ready = "true";
    state.canvasLayer.appendChild(generation);
    for (const child of [...state.canvasLayer.children]) if (child !== generation) releaseGeneration(child);
  }

  async function renderTiles(state, page, renderViewport, outputScale, tiles, key) {
    const canvases = [];
    const tasks = tiles.map(async (tile) => {
      const canvas = document.createElement("canvas");
      canvas.dataset.tile = tileKey(tile);
      canvas.width = tile.w; canvas.height = tile.h;
      canvas.style.left = `${tile.x / outputScale}px`;
      canvas.style.top = `${tile.y / outputScale}px`;
      canvas.style.width = `${tile.w / outputScale}px`;
      canvas.style.height = `${tile.h / outputScale}px`;
      canvases.push(canvas);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "white"; context.fillRect(0, 0, tile.w, tile.h);
      const task = page.render({
        canvasContext: context,
        viewport: renderViewport,
        transform: [1, 0, 0, 1, -tile.x, -tile.y],
        annotationMode: pdfAnnotationModeDisabled(),
      });
      state.renderTasks.add(task);
      try { await task.promise; }
      catch (error) { if (error?.name !== "RenderingCancelledException") throw error; }
      finally { state.renderTasks.delete(task); }
    });
    try { await Promise.all(tasks); }
    catch (error) {
      releaseCanvases(canvases);
      if (!disposed && state.renderKey === key) state.renderKey = "";
      if (!disposed && error?.name !== "RenderingCancelledException") console.warn("PDF page render failed", error);
      return null;
    }
    return canvases;
  }

  function scaleCanvasGenerations(state) {
    if (!state.viewport) return;
    for (const generation of state.canvasLayer.children) {
      const width = Number(generation.dataset.viewportWidth);
      const height = Number(generation.dataset.viewportHeight);
      if (!(width > 0) || !(height > 0)) continue;
      generation.style.transform = `scale(${state.viewport.width / width}, ${state.viewport.height / height})`;
    }
  }

  function desiredTiles(state, viewport, outputScale, pageRect) {
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    if (width <= 4096 && height <= 4096 && width * height <= FULL_PAGE_PIXELS) return [{ x: 0, y: 0, w: width, h: height }];
    const rootRect = scroll.getBoundingClientRect();
    const left = Math.max(0, (rootRect.left - pageRect.left) / (pageRect.width / state.viewport.width) * outputScale);
    const top = Math.max(0, (rootRect.top - pageRect.top) / (pageRect.height / state.viewport.height) * outputScale);
    const right = Math.min(width, (rootRect.right - pageRect.left) / (pageRect.width / state.viewport.width) * outputScale);
    const bottom = Math.min(height, (rootRect.bottom - pageRect.top) / (pageRect.height / state.viewport.height) * outputScale);
    const firstX = Math.max(0, Math.floor(left / TILE_PIXELS) - 1);
    const lastX = Math.min(Math.ceil(width / TILE_PIXELS) - 1, Math.floor(Math.max(left, right - 1) / TILE_PIXELS) + 1);
    const firstY = Math.max(0, Math.floor(top / TILE_PIXELS) - 1);
    const lastY = Math.min(Math.ceil(height / TILE_PIXELS) - 1, Math.floor(Math.max(top, bottom - 1) / TILE_PIXELS) + 1);
    const tiles = [];
    for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
      const nominalX = x * TILE_PIXELS, nominalY = y * TILE_PIXELS;
      const px = Math.max(0, nominalX - 1), py = Math.max(0, nominalY - 1);
      const rightEdge = Math.min(width, nominalX + TILE_PIXELS + 1);
      const bottomEdge = Math.min(height, nominalY + TILE_PIXELS + 1);
      tiles.push({ x: px, y: py, w: rightEdge - px, h: bottomEdge - py });
    }
    return tiles;
  }

  function cancelRenderTasks(state) {
    for (const task of state.renderTasks) task.cancel?.();
    state.renderTasks.clear();
  }

  function refreshAllMarks() {
    for (const state of pageStates) state.marks.replaceChildren();
    for (const child of childrenOf(node.id)) {
      if (child.origin?.anchor?.pdf) mountPdfRectMark(container, child.origin.anchor, child.id, `rh-pdf-mark ${child.status === "answered" ? "mark-ready" : "mark-pending"}`);
    }
  }

  function pdfPointAtClient(clientX, clientY) {
    const state = pageStateAt(clientX, clientY);
    if (!state?.viewport) return null;
    const rect = state.element.getBoundingClientRect();
    const x = (clientX - rect.left) * state.viewport.width / rect.width;
    const y = (clientY - rect.top) * state.viewport.height / rect.height;
    return { state, point: state.viewport.convertToPdfPoint(x, y) };
  }

  function restoreClientAnchor(pinned, clientX, clientY) {
    const state = pinned.state;
    if (!state.viewport) return;
    const rect = state.element.getBoundingClientRect();
    const point = state.viewport.convertToViewportPoint(pinned.point[0], pinned.point[1]);
    const scale = rect.width / state.viewport.width;
    scroll.scrollLeft += (rect.left + point[0] * scale - clientX) / Math.max(scale, 0.001);
    scroll.scrollTop += (rect.top + point[1] * scale - clientY) / Math.max(scale, 0.001);
  }

  function pageStateAt(clientX, clientY) {
    return pageStates.find((state) => {
      const rect = state.element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }) || null;
  }

  function selectionToAsk() {
    if (boxMode || disposed) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    const fragments = [];
    for (const state of pageStates) {
      if (!state.textItems?.length || !state.viewport) continue;
      const quads = [];
      for (const span of state.textDivs || []) {
        if (!range.intersectsNode(span) || !span.firstChild) continue;
        const offsets = selectedOffsets(range, span.firstChild);
        if (offsets.end <= offsets.start) continue;
        const item = state.textItems[Number(span.dataset.pdfItem)];
        if (!item) continue;
        quads.push(...textSelectionQuads(span.firstChild, offsets.start, offsets.end, state.element, state.viewport, item, state.textStyles[item.fontName] || {}, state.textMetrics[Number(span.dataset.pdfItem)]));
      }
      if (quads.length) fragments.push({ page: state.meta.n, quads });
    }
    const selectedText = selection.toString().trim();
    if (!selectedText || !fragments.length) return;
    const anchor = { version: 2, source_sha256: pdf.source.sha256, kind: "text", fragments };
    showAskFromSelection({
      parentId: node.id,
      selectedText,
      mdStart: 0,
      mdEnd: 0,
      pdfAnchor: anchor,
      range: range.cloneRange(),
      anchorRectEl: { contextElement: container, getBoundingClientRect: () => range.getBoundingClientRect() },
    });
  }

  function beginRegion(state, event) {
    if (!boxMode || event.button !== 0 || !state.viewport) return;
    event.preventDefault(); event.stopPropagation();
    const rect = state.element.getBoundingClientRect();
    const start = clientToViewport(event.clientX, event.clientY, rect, state.viewport);
    const draft = document.createElement("div");
    draft.className = "rh-pdf-box-draft";
    state.element.appendChild(draft);
    state.element.setPointerCapture?.(event.pointerId);
    let current = start;
    const move = (moveEvent) => {
      current = clientToViewport(moveEvent.clientX, moveEvent.clientY, rect, state.viewport);
      const x = Math.min(start[0], current[0]), y = Math.min(start[1], current[1]);
      const w = Math.abs(current[0] - start[0]), h = Math.abs(current[1] - start[1]);
      draft.style.left = `${x}px`; draft.style.top = `${y}px`; draft.style.width = `${w}px`; draft.style.height = `${h}px`;
    };
    const cleanup = () => {
      state.element.removeEventListener("pointermove", move);
      state.element.removeEventListener("pointerup", finish);
      state.element.removeEventListener("pointercancel", cancel);
    };
    const finish = () => {
      cleanup();
      const x0 = Math.min(start[0], current[0]), y0 = Math.min(start[1], current[1]);
      const x1 = Math.max(start[0], current[0]), y1 = Math.max(start[1], current[1]);
      if ((x1 - x0) < 8 || (y1 - y0) < 8) { draft.remove(); return; }
      const quad = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => state.viewport.convertToPdfPoint(x, y));
      const anchor = { version: 2, source_sha256: pdf.source.sha256, kind: "region", fragments: [{ page: state.meta.n, quads: [quad] }] };
      draft.classList.add("settled");
      state.regionDraft = { element: draft, quad };
      positionRegionDraft(state);
      toolbar.setBoxMode(false);
      boxMode = false; container.classList.remove("rh-pdf-box-mode");
      showAskFromSelection({ parentId: node.id, selectedText: textInsideQuad(state, quad), mdStart: 0, mdEnd: 0, pdfAnchor: anchor, anchorRectEl: draft });
      retireWhenAskCloses(draft, () => { if (state.regionDraft?.element === draft) state.regionDraft = null; });
    };
    const cancel = () => { cleanup(); draft.remove(); };
    state.element.addEventListener("pointermove", move);
    state.element.addEventListener("pointerup", finish);
    state.element.addEventListener("pointercancel", cancel);
  }

  function positionRegionDraft(state) {
    const pending = state.regionDraft;
    if (!pending || !state.viewport) return;
    if (!pending.element.isConnected) { state.regionDraft = null; return; }
    const points = pending.quad.map((point) => state.viewport.convertToViewportPoint(point[0], point[1]));
    const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    pending.element.style.left = `${x0}px`;
    pending.element.style.top = `${y0}px`;
    pending.element.style.width = `${x1 - x0}px`;
    pending.element.style.height = `${y1 - y0}px`;
  }

  function beginTextSelection(event) {
    if (boxMode || event.button !== 0 || event.pointerType === "touch") return;
    const span = event.target?.closest?.(".rh-pdf-textlayer span[data-pdf-item]");
    if (!span || !container.contains(span)) return;
    const start = textPositionAtPoint(container, event.clientX, event.clientY, span);
    if (!start) return;
    // Own the complete gesture. Otherwise Chromium on Linux can turn the first
    // programmatic range into a native text drag and cancel the pointer stream.
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    textGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start, moved: false };
  }

  function moveTextSelection(event) {
    const gesture = textGesture;
    if (!gesture || gesture.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 3) return;
    const end = textPositionAtPoint(container, event.clientX, event.clientY);
    if (!end) return;
    gesture.moved = true;
    const selection = window.getSelection();
    if (!selection) return;
    if (typeof selection.setBaseAndExtent === "function") selection.setBaseAndExtent(gesture.start.node, gesture.start.offset, end.node, end.offset);
    else {
      const range = document.createRange(); range.setStart(gesture.start.node, gesture.start.offset); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range); selection.extend?.(end.node, end.offset);
    }
    event.preventDefault();
  }

  function finishTextSelection(event) {
    const gesture = textGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    textGesture = null;
    // Preventing pointermove can suppress the compatibility mouseup event, so
    // complete a real drag from its pointer lifecycle instead of relying on it.
    if (event.type === "pointerup" && gesture.moved) selectionToAsk();
  }

  function selectTextWord(event) {
    if (boxMode || event.button !== 0) return;
    const span = event.target?.closest?.(".rh-pdf-textlayer span[data-pdf-item]");
    const textNode = span?.firstChild;
    if (!span || !container.contains(span) || textNode?.nodeType !== 3) return;
    if (selectWordAtPoint(span, textNode, event.clientX, event.clientY)) selectionToAsk();
  }

  function initializePages() {
    for (const meta of pdf.pages) {
      const element = document.createElement("section");
      element.className = "rh-pdf-page";
      element.dataset.page = String(meta.n);
      element.setAttribute("aria-label", `PDF page ${meta.n}`);
      const rawWidth = meta.view[2] - meta.view[0], rawHeight = meta.view[3] - meta.view[1];
      const displayWidth = meta.rotate % 180 ? rawHeight : rawWidth;
      const displayHeight = meta.rotate % 180 ? rawWidth : rawHeight;
      element.style.width = "min(100%, 760px)";
      element.style.aspectRatio = `${displayWidth} / ${displayHeight}`;
      const canvasLayer = document.createElement("div"); canvasLayer.className = "rh-pdf-canvas-layer";
      const textLayer = document.createElement("div"); textLayer.className = "rh-pdf-textlayer";
      const marks = document.createElementNS("http://www.w3.org/2000/svg", "svg"); marks.classList.add("rh-pdf-marks");
      element.append(canvasLayer, textLayer, marks);
      const state = { meta, element, canvasLayer, textLayer, marks, page: null, viewport: null, displayScale: 1, textContent: null, textContentPromise: null, operatorListPromise: null, textItems: [], textStyles: {}, textMetrics: [], textDivs: [], textTask: null, textGeneration: 0, textKey: "", renderTasks: new Set(), renderKey: "", regionDraft: null };
      element.addEventListener("pointerdown", (event) => { beginRegion(state, event); beginTextSelection(event); });
      element.addEventListener("dblclick", selectTextWord);
      pageStates.push(state); stack.appendChild(element);
    }
    intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const state = pageStates.find((candidate) => candidate.element === entry.target);
        if (!state) continue;
        if (entry.isIntersecting) { visiblePages.add(state); void ensurePage(state).then(scheduleRender); }
        else visiblePages.delete(state);
      }
    }, { root: scroll, rootMargin: "100% 0px" });
    pageStates.forEach((state) => intersectionObserver.observe(state.element));
  }

  const onWheel = (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    setZoom(localZoom * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !boxMode) return;
    event.preventDefault();
    event.stopPropagation();
    boxMode = false;
    toolbar.setBoxMode(false);
    container.classList.remove("rh-pdf-box-mode");
    for (const draft of container.querySelectorAll(".rh-pdf-box-draft")) draft.remove();
  };
  const onSelectionMouseUp = (event) => {
    // A selection ask belongs to a completed text-layer gesture. Toolbar and
    // scrollbar mouseups must never resurrect a stale browser selection.
    if (!event.target?.closest?.(".rh-pdf-textlayer")) return;
    selectionToAsk();
  };
  scroll.addEventListener("wheel", onWheel, { passive: false });
  scroll.addEventListener("scroll", scheduleRender, { passive: true });
  container.addEventListener("mouseup", onSelectionMouseUp);
  document.addEventListener("pointermove", moveTextSelection, { passive: false });
  document.addEventListener("pointerup", finishTextSelection);
  document.addEventListener("pointercancel", finishTextSelection);
  document.addEventListener("keydown", onKeyDown, true);
  touchCleanup = installTouchZoom(scroll, () => localZoom, setZoom);

  initializePages();
  documentReady = acquirePdfDocument({ key: pdf.source.sha256, url: resolveAssetUrl(pdf.source.asset) }).then((lease) => {
    if (disposed) { lease.release(); return; }
    documentLease = lease; documentProxy = lease.document;
    toolbar.setReady(true);
  });
  documentReady.then(() => ensurePage(pageStates[0])).then(() => { updatePageLayouts(); scheduleRender(); }).catch((error) => toolbar.setError(error?.message || String(error)));

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => { updatePageLayouts(); scheduleRender(); });
    resizeObserver.observe(scroll);
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    if (zoomFrame) cancelAnimationFrame(zoomFrame);
    intersectionObserver?.disconnect(); resizeObserver?.disconnect();
    scroll.removeEventListener("wheel", onWheel);
    container.removeEventListener("mouseup", onSelectionMouseUp);
    document.removeEventListener("pointermove", moveTextSelection);
    document.removeEventListener("pointerup", finishTextSelection);
    document.removeEventListener("pointercancel", finishTextSelection);
    document.removeEventListener("keydown", onKeyDown, true);
    touchCleanup();
    for (const state of pageStates) {
      state.textTask?.cancel?.(); cancelRenderTasks(state); state.page?.cleanup?.();
      for (const generation of [...state.canvasLayer.children]) releaseGeneration(generation);
    }
    documentLease?.release();
    readerToolbarHost?.style?.removeProperty("--rh-pdf-reader-center");
    toolbar.element.remove();
    delete container._rhPdfToolbarElement;
    toolbar.dispose();
  };
}

function textPositionAtPoint(container, clientX, clientY, fallbackSpan = null) {
  const position = document.caretPositionFromPoint?.(clientX, clientY);
  if (position?.offsetNode?.nodeType === 3 && container.contains(position.offsetNode)) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const caret = document.caretRangeFromPoint?.(clientX, clientY);
  if (caret?.startContainer?.nodeType === 3 && container.contains(caret.startContainer)) {
    return { node: caret.startContainer, offset: caret.startOffset };
  }
  const span = fallbackSpan || document.elementFromPoint(clientX, clientY)?.closest?.(".rh-pdf-textlayer span[data-pdf-item]");
  const textNode = span?.firstChild;
  if (!span || !container.contains(span) || textNode?.nodeType !== 3) return null;
  const rect = span.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return { node: textNode, offset: Math.round(ratio * (textNode.nodeValue?.length || 0)) };
}

function selectWordAtPoint(span, textNode, clientX, clientY) {
  const text = textNode.nodeValue || "";
  if (!text) return false;
  let offset = null;
  const position = document.caretPositionFromPoint?.(clientX, clientY);
  if (position?.offsetNode === textNode) offset = position.offset;
  if (offset == null) {
    const caret = document.caretRangeFromPoint?.(clientX, clientY);
    if (caret?.startContainer === textNode) offset = caret.startOffset;
  }
  if (offset == null) {
    const rect = span.getBoundingClientRect();
    offset = Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))) * text.length);
  }
  offset = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const words = [...text.matchAll(/[\p{L}\p{N}\p{M}_]+(?:[\u2019'\u2010\u2011\u2013-][\p{L}\p{N}\p{M}_]+)*/gu)];
  const word = words.find((match) => offset >= match.index && offset < match.index + match[0].length)
    || words.find((match) => offset > match.index && offset <= match.index + match[0].length);
  if (!word) return false;
  const range = document.createRange();
  range.setStart(textNode, word.index);
  range.setEnd(textNode, word.index + word[0].length);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function createToolbar(pdf, node, { reader = false } = {}) {
  const element = document.createElement("div"); element.className = "rh-pdf-toolbar";
  const scanned = pdf.lines.length === 0;
  const regionActions = document.createElement("div"); regionActions.className = "rh-pdf-toolbar-actions rh-pdf-region-actions";
  const region = button("Ask about an area", "Ask about an area of the PDF");
  region.className += " rh-pdf-box-toggle";
  region.setAttribute("aria-pressed", "false");
  region.innerHTML = `${iconSvg("area-select")}<span>${reader ? "Area" : "Ask about an area"}</span>`;
  regionActions.appendChild(region);

  const center = document.createElement("div"); center.className = "rh-pdf-toolbar-center";
  const zoomControls = document.createElement("div"); zoomControls.className = "rh-pdf-zoom-controls";
  const minus = button("", "Zoom PDF out");
  minus.className += " rh-pdf-zoom-control";
  minus.innerHTML = iconSvg("zoom-out");
  const zoom = button("100%", "Reset PDF zoom"); zoom.className += " rh-pdf-zoom-value rh-pdf-zoom-control";
  const plus = button("", "Zoom PDF in");
  plus.className += " rh-pdf-zoom-control";
  plus.innerHTML = iconSvg("zoom-in");
  zoomControls.append(minus, zoom, plus);
  const message = document.createElement("span");
  message.className = "rh-pdf-toolbar-message";
  message.setAttribute("role", "status");
  message.hidden = true;
  center.append(zoomControls, message);

  const documentActions = document.createElement("div"); documentActions.className = "rh-pdf-toolbar-actions rh-pdf-document-actions";
  if (!pdf.converted && !childrenOf(node.id).length) {
    const convert = button("Create text version", "Turn every page into clean, searchable text while preserving figures");
    convert.className += " rh-pdf-convert";
    convert.innerHTML = `${iconSvg("file-text")}<span>${reader ? "Text version" : "Create text version"}</span>`;
    if (scanned) convert.className += " primary";
    convert.addEventListener("click", (event) => { event.stopPropagation(); convert.disabled = true; postBrowserEvent({ type: "convert_pdf", node_id: node.id }).then((result) => { if (!result?.ok) convert.disabled = false; }); });
    documentActions.appendChild(convert);
  }
  element.append(regionActions, center, documentActions);
  let zoomHandler = () => {}, boxHandler = () => {}, boxMode = false;
  minus.addEventListener("click", () => zoomHandler(-1));
  plus.addEventListener("click", () => zoomHandler(1));
  zoom.addEventListener("click", () => zoomHandler(0));
  region.addEventListener("click", () => { boxMode = !boxMode; region.classList.toggle("active", boxMode); region.setAttribute("aria-pressed", String(boxMode)); boxHandler(boxMode); });
  return {
    element,
    onZoom(handler) { zoomHandler = (direction) => handler(direction === 0 ? 1 : Number(zoom.dataset.value || 1) * (direction < 0 ? 0.8 : 1.25), null); },
    onBoxMode(handler) { boxHandler = handler; },
    setBoxMode(value) { boxMode = !!value; region.classList.toggle("active", boxMode); region.setAttribute("aria-pressed", String(boxMode)); },
    setZoom(value) { zoom.dataset.value = String(value); zoom.textContent = `${Math.round(value * 100)}%`; },
    setReady() {},
    setError(error) {
      zoomControls.hidden = true;
      message.hidden = false;
      message.textContent = "PDF unavailable";
      message.title = String(error || "The source PDF could not be opened.");
      element.classList.add("error");
    },
    dispose() {},
  };
}

function button(text, label) {
  const out = document.createElement("button"); out.type = "button"; out.className = "node-btn"; out.textContent = text; out.setAttribute("aria-label", label); return out;
}

function mountLegacyNotice(container) {
  const notice = document.createElement("div"); notice.className = "rh-pdf-legacy"; notice.textContent = "This PDF uses the retired image-based format. Re-import the original PDF for source-quality rendering and accurate selections."; container.prepend(notice);
}

function clientToViewport(clientX, clientY, rect, viewport) {
  return [
    Math.min(viewport.width, Math.max(0, (clientX - rect.left) * viewport.width / rect.width)),
    Math.min(viewport.height, Math.max(0, (clientY - rect.top) * viewport.height / rect.height)),
  ];
}

function selectedOffsets(range, textNode) {
  let start = 0, end = textNode.nodeValue?.length || 0;
  if (range.startContainer === textNode) start = range.startOffset;
  if (range.endContainer === textNode) end = range.endOffset;
  return { start: Math.max(0, Math.min(end, start)), end: Math.max(start, end) };
}

function textSelectionQuads(textNode, start, end, page, viewport, item, style, metrics) {
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const pageRect = page.getBoundingClientRect();
  if (!(pageRect.width > 0) || !(pageRect.height > 0)) return [];
  const scaleX = viewport.width / pageRect.width;
  const scaleY = viewport.height / pageRect.height;
  const native = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => [
      [rect.left, rect.top],
      [rect.right, rect.top],
      [rect.right, rect.bottom],
      [rect.left, rect.bottom],
    ].map(([clientX, clientY]) => viewport.convertToPdfPoint(
      (clientX - pageRect.left) * scaleX,
      (clientY - pageRect.top) * scaleY,
    )));
  if (style.vertical || !Array.isArray(item?.transform) || item.transform.length < 6) return native;
  const [a, b, c, d, e, f] = item.transform.map(Number);
  const baselineLength = Math.hypot(a, b);
  if (!(baselineLength > 0) || ![c, d, e, f].every(Number.isFinite)) return native;
  const baseline = [a / baselineLength, b / baselineLength];
  const ascent = Number.isFinite(Number(style.ascent)) ? Number(style.ascent) : 1;
  const descent = Number.isFinite(Number(style.descent)) ? Number(style.descent) : 0;
  const origin = [e, f];
  const along = (point) => (point[0] - e) * baseline[0] + (point[1] - f) * baseline[1];
  const at = (advance, ratio) => [
    origin[0] + baseline[0] * advance + c * ratio,
    origin[1] + baseline[1] * advance + d * ratio,
  ];
  return native.map((quad) => {
    const advances = quad.map(along);
    const begin = Number.isFinite(metrics?.[start]) ? metrics[start] : Math.min(...advances);
    const finish = Number.isFinite(metrics?.[end]) ? metrics[end] : Math.max(...advances);
    return [at(begin, ascent), at(finish, ascent), at(finish, descent), at(begin, descent)];
  });
}

function exactTextItemMetrics(items, operatorList, showTextOpcode) {
  const output = Array(items.length).fill(null);
  if (!Number.isFinite(showTextOpcode) || !Array.isArray(operatorList?.fnArray)) return output;
  const runs = [];
  for (let index = 0; index < operatorList.fnArray.length; index++) {
    if (operatorList.fnArray[index] !== showTextOpcode) continue;
    const glyphs = operatorList.argsArray?.[index]?.[0];
    if (!Array.isArray(glyphs)) continue;
    const text = glyphs.filter((value) => value && typeof value === "object").map((glyph) => String(glyph.unicode || "")).join("");
    if (compactText(text)) runs.push({ glyphs, text: compactText(text) });
  }
  let cursor = 0;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex], target = compactText(item?.str);
    if (!target || item?.dir === "rtl") continue;
    let match = -1;
    for (let runIndex = cursor; runIndex < Math.min(runs.length, cursor + 5); runIndex++) {
      if (runs[runIndex].text === target) { match = runIndex; break; }
    }
    if (match < 0) continue;
    output[itemIndex] = glyphBoundaryMetrics(String(item.str), runs[match].glyphs, Number(item.width));
    cursor = match + 1;
  }
  return output;
}

function glyphBoundaryMetrics(text, glyphs, itemWidth) {
  if (!(itemWidth >= 0)) return null;
  let advance = 0;
  const records = [];
  for (const value of glyphs) {
    if (typeof value === "number") { advance -= value; continue; }
    const unicode = String(value?.unicode || ""), width = Number(value?.width);
    if (!unicode || !Number.isFinite(width)) continue;
    const characters = [...unicode];
    for (let index = 0; index < characters.length; index++) records.push({
      character: characters[index],
      start: advance + width * index / characters.length,
      end: advance + width * (index + 1) / characters.length,
    });
    advance += width;
  }
  if (!(advance > 0)) return null;
  const textCharacters = [], glyphCharacters = records.filter((record) => !/\s/u.test(record.character));
  for (let offset = 0; offset < text.length;) {
    const point = text.codePointAt(offset), character = String.fromCodePoint(point);
    const next = offset + character.length;
    if (!/\s/u.test(character)) textCharacters.push({ character, start: offset, end: next });
    offset = next;
  }
  if (textCharacters.length !== glyphCharacters.length) return null;
  for (let index = 0; index < textCharacters.length; index++) {
    if (compactText(textCharacters[index].character) !== compactText(glyphCharacters[index].character)) return null;
  }
  const boundaries = Array(text.length + 1).fill(null);
  boundaries[0] = 0; boundaries[text.length] = itemWidth;
  for (let index = 0; index < textCharacters.length; index++) {
    const textCharacter = textCharacters[index], glyph = glyphCharacters[index];
    boundaries[textCharacter.start] = glyph.start / advance * itemWidth;
    boundaries[textCharacter.end] = glyph.end / advance * itemWidth;
  }
  for (let index = 0; index < boundaries.length;) {
    if (boundaries[index] != null) { index++; continue; }
    const first = index - 1;
    while (index < boundaries.length && boundaries[index] == null) index++;
    const last = index, span = last - first;
    for (let fill = first + 1; fill < last; fill++) boundaries[fill] = boundaries[first] + (boundaries[last] - boundaries[first]) * (fill - first) / span;
  }
  return boundaries;
}

function compactText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "");
}

async function useEmbeddedTextLayerFonts(page, items, styles) {
  const names = [...new Set(items.map((item) => item?.fontName).filter((name) => typeof name === "string" && styles[name]))];
  await Promise.all(names.map((name) => new Promise((resolve) => {
    if (page.commonObjs.has(name)) { resolve(); return; }
    page.commonObjs.get(name, resolve);
  })));
  for (const name of names) {
    let font;
    try { font = page.commonObjs.get(name); } catch { continue; }
    if (!font?.loadedName) continue;
    const fallback = String(font.fallbackName || styles[name].fontFamily || "sans-serif");
    styles[name] = { ...styles[name], fontFamily: `"${font.loadedName}", ${fallback}` };
  }
}

function tuneTextLayerSpacing(divs, items, styles, properties, viewport) {
  if (!textMeasureContext) return;
  for (let index = 0; index < divs.length; index++) {
    const div = divs[index], item = items[index], props = properties.get(div), text = String(item?.str || "");
    const spaces = [...text].filter((character) => /\s/u.test(character)).length;
    if (!spaces || !props?.canvasWidth || styles[item.fontName]?.vertical) continue;
    const fontSize = Number(props.fontSize) * viewport.scale;
    if (!(fontSize > 0)) continue;
    textMeasureContext.font = `${fontSize}px ${div.style.fontFamily || styles[item.fontName]?.fontFamily || "sans-serif"}`;
    const measured = textMeasureContext.measureText(text).width;
    const desired = Number(props.canvasWidth) * viewport.scale;
    if (!(measured > 0) || !(desired > 0)) continue;
    div.style.wordSpacing = `${(desired - measured) / spaces}px`;
    div.style.transform = Number(props.angle) ? `rotate(${Number(props.angle)}deg)` : "";
  }
}

function textInsideQuad(state, quad) {
  const xs = quad.map((point) => point[0]), ys = quad.map((point) => point[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const values = [];
  for (const item of state.textItems || []) {
    const x = Number(item.transform?.[4]), y = Number(item.transform?.[5]);
    if (x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3] && String(item.str || "").trim()) values.push(item.str);
  }
  return values.join(" ").replace(/\s+/g, " ").trim();
}

function retireWhenAskCloses(element, onRemove = () => {}) {
  const ask = document.getElementById("ask");
  if (!ask || typeof MutationObserver !== "function") { onRemove(); element.remove(); return; }
  const observer = new MutationObserver(() => { if (!ask.classList.contains("visible")) { observer.disconnect(); onRemove(); element.remove(); } });
  observer.observe(ask, { attributes: true, attributeFilter: ["class"] });
}

function tileKey(tile) {
  return `${tile.x},${tile.y},${tile.w},${tile.h}`;
}

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

function releaseCanvases(canvases) {
  for (const canvas of canvases) releaseCanvas(canvas);
}

function releaseGeneration(generation) {
  for (const canvas of generation.querySelectorAll?.("canvas") || []) releaseCanvas(canvas);
  generation.remove();
}

function installTouchZoom(element, getZoom, setZoom) {
  const touches = new Map();
  let gesture = null;
  const down = (event) => {
    if (event.pointerType !== "touch") return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2) return;
    const pair = [...touches.values()];
    gesture = { distance: Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y)), zoom: getZoom() };
    event.preventDefault(); event.stopPropagation();
  };
  const move = (event) => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!gesture || touches.size < 2) return;
    const pair = [...touches.values()].slice(0, 2);
    const midpoint = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
    setZoom(gesture.zoom * Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) / gesture.distance, midpoint);
    event.preventDefault(); event.stopPropagation();
  };
  const end = (event) => { touches.delete(event.pointerId); if (touches.size < 2) gesture = null; };
  element.addEventListener("pointerdown", down, { passive: false });
  element.addEventListener("pointermove", move, { passive: false });
  element.addEventListener("pointerup", end); element.addEventListener("pointercancel", end);
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", end);
    element.removeEventListener("pointercancel", end);
    touches.clear(); gesture = null;
  };
}

export function syncPdfTranscriptionControls(root, capability) {
  if (!root?.querySelectorAll) return;
  const available = capability?.available !== false;
  const reason = String(capability?.reason || "Set up a vision-capable PDF transcription model in Model settings.");
  const containers = root.matches?.(".doc-content.rh-pdf") ? [root] : Array.from(root.querySelectorAll(".doc-content.rh-pdf"));
  containers.forEach((container) => {
    const toolbarRoot = container._rhPdfToolbarElement || container;
    const button = toolbarRoot.querySelector(".rh-pdf-convert");
    if (!button) return;
    button.disabled = !available;
    button.title = available ? "Turn every page into clean, searchable text while preserving figures" : reason;
  });
}
