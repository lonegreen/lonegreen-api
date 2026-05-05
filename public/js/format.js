(function(){
  function formatMoney(value){
    return "$" + Number(value || 0).toFixed(2);
  }

  function money(value){
    return formatMoney(value);
  }

  function escapeHtml(value){
    return String(value || "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function normalizeDate(value){
    if(!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, fallback = ""){
    const date = normalizeDate(value);
    return date ? date.toLocaleDateString() : fallback;
  }

  function formatDateInput(value){
    return value ? String(value).split("T")[0] : "";
  }

  function formatTime(value){
    if(!value) return "";
    const [hourRaw, minuteRaw] = String(value).split(":");
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw || 0);
    if(Number.isNaN(hour)) return String(value);
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return displayHour + ":" + String(minute).padStart(2, "0") + " " + suffix;
  }

  function formatTimeRange(start, end){
    const startText = formatTime(start);
    const endText = formatTime(end);
    if(startText && endText) return startText + " - " + endText;
    return startText || endText || "";
  }

  window.AppFormat = {
    formatMoney,
    money,
    escapeHtml,
    normalizeDate,
    formatDate,
    formatDateInput,
    formatTime,
    formatTimeRange
  };

})();
