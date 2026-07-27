/* Theme bootstrap. Loaded synchronously from <head> — before any content
   paints — so the saved theme is applied without a flash of the wrong one.
   Lives in its own file rather than inline so the CSP can stay on `script-src
   'self'` with no nonce or hash to keep in sync. */
(function () {
  try {
    var t = localStorage.getItem("wg-theme");
    if (!t) t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
