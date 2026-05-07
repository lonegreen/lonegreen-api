// Compatibility shim. Shared shell helpers live in /js/ui.js.
(function(){
  if(window.AppUI) return;
  var script = document.createElement("script");
  script.src = "/js/ui.js";
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
})();
