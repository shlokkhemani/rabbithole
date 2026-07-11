/**
 * Owns resources created during one UI lifetime. Cleanups run once, in reverse
 * registration order, so dependants are released before the resources they use.
 */
export function createCleanupScope() {
  var cleanups = new Set();
  var disposed = false;

  function addCleanup(cleanup) {
    if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function");
    var active = true;
    function run() {
      if (!active) return;
      active = false;
      cleanups.delete(run);
      cleanup();
    }
    if (disposed) run();
    else cleanups.add(run);
    return run;
  }

  function listen(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("Lifecycle listener target must be an EventTarget");
    }
    target.addEventListener(type, listener, options);
    return addCleanup(function(){ target.removeEventListener(type, listener, options); });
  }

  function interval(callback, delay) {
    var id = setInterval(callback, delay);
    addCleanup(function(){ clearInterval(id); });
    return id;
  }

  function timeout(callback, delay) {
    var cancel = null;
    var id = setTimeout(function(){
      if (cancel) cancel();
      callback();
    }, delay);
    cancel = addCleanup(function(){ clearTimeout(id); });
    return id;
  }

  function raf(callback) {
    var cancel = null;
    var id = nextFrame(function(timestamp){
      if (cancel) cancel();
      callback(timestamp);
    });
    cancel = addCleanup(function(){ cancelFrame(id); });
    return id;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    var pending = Array.from(cleanups);
    cleanups.clear();
    var errors = [];
    for (var i = pending.length - 1; i >= 0; i--) {
      try { pending[i](); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Lifecycle cleanup failed");
  }

  return {
    addCleanup: addCleanup,
    listen: listen,
    interval: interval,
    timeout: timeout,
    raf: raf,
    dispose: dispose,
    get disposed(){ return disposed; }
  };
}

/** @param {(timestamp: number) => void} callback */
export function nextFrame(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(function(){
    callback(typeof performance === "object" ? performance.now() : Date.now());
  }, 16);
}

/** @param {number} handle */
export function cancelFrame(handle) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  clearTimeout(handle);
}
