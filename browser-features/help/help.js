// At panel-sidebar width the topic list is collapsed; this is its toggle.
document.getElementById("menuToggle")?.addEventListener("click", (event) => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const open = nav.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
