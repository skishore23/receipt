import { initReceiptBrowser } from "./factory-client/receipt-browser";
import { initFactoryWorkbenchBrowser } from "./factory-client/workbench";

const boot = () => {
  if (document.querySelector("[data-factory-workbench]")) initFactoryWorkbenchBrowser();
  if (document.querySelector("[data-receipt-browser]")) initReceiptBrowser();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
