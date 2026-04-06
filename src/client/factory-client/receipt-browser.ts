export const initReceiptBrowser = () => {
  document.addEventListener("click", (event) => {
    const row = event.target instanceof Element ? event.target.closest("[data-receipt-row]") : null;
    if (!row) return;
    row.classList.toggle("receipt-expanded");
  });
};
