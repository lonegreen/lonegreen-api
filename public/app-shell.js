// Compatibility shim. Shared shell helpers live in /js/ui.js.
(function(){
  if(window.AppUI) return;
  document.write('<script src="/js/ui.js"><\\/script>');
})();
