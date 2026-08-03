(function () {
  "use strict";

  function ts() {
    const d = new Date();
    return d.toTimeString().split(" ")[0] + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function make(tag, color) {
    const prefix = `%c[${ts()}] [${tag}]`;
    const style = `color:${color};font-weight:600`;
    return {
      info: (...args) => console.log(prefix, style, ...args),
      warn: (...args) => console.warn(prefix, style, ...args),
      error: (...args) => console.error(prefix, style, ...args),
      debug: (...args) => console.debug(prefix, style, ...args),
    };
  }

  window.Log = {
    app: make("app", "#0559C9"),
    ws: make("ws", "#7A3FE0"),
    transfer: make("transfer", "#0FAE60"),
    opfs: make("opfs", "#C77A08"),
    ui: make("ui", "#E0293D"),
    files: make("files", "#0891B2"),
  };

  window.addEventListener("error", (e) => {
    window.Log.app.error("Uncaught error:", e.error || e.message, e);
  });
  
  window.addEventListener("unhandledrejection", (e) => {
    window.Log.app.error("Unhandled promise rejection:", e.reason);
  });

  window.Log.app.info("Logger ready");
})();
