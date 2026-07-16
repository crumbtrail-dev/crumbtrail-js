import { WIDGET_CSS } from "./styles";
import type { Crumbtrail } from "../bug-logger";

const BUG_SVG = `<svg viewBox="0 0 24 24"><path d="M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>`;

export function mountWidget(logger: Crumbtrail): () => void {
  const host = document.createElement("div");
  host.id = "crumbtrail-widget";
  const shadow = host.attachShadow({ mode: "closed" });

  // Styles
  const style = document.createElement("style");
  style.textContent = WIDGET_CSS;
  shadow.appendChild(style);

  // Trigger button
  const trigger = document.createElement("button");
  trigger.className = "bl-trigger";
  trigger.innerHTML = BUG_SVG;
  trigger.title = "Something went wrong. Attach a report.";
  trigger.setAttribute("aria-label", "Something went wrong. Attach a report.");
  shadow.appendChild(trigger);

  // Popover
  const popover = document.createElement("div");
  popover.className = "bl-popover";
  popover.innerHTML = `
    <h3>Flag a Bug</h3>
    <textarea class="bl-note" placeholder="What went wrong? (optional)"></textarea>
    <div class="bl-actions">
      <button class="bl-btn bl-submit">Send Bug Report</button>
    </div>
    <div class="bl-status"></div>
    <div class="bl-hint">Ctrl+Shift+B to toggle</div>
  `;
  shadow.appendChild(popover);

  const noteInput = popover.querySelector(".bl-note") as HTMLTextAreaElement;
  const submitBtn = popover.querySelector(".bl-submit") as HTMLButtonElement;
  const statusEl = popover.querySelector(".bl-status") as HTMLDivElement;

  let isOpen = false;

  function toggle() {
    isOpen = !isOpen;
    popover.classList.toggle("open", isOpen);
    if (isOpen) {
      noteInput.focus();
    } else {
      reset();
    }
  }

  function reset() {
    noteInput.value = "";
    statusEl.textContent = "";
  }

  trigger.addEventListener("click", toggle);

  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    statusEl.textContent = "Sending...";

    try {
      const { bugId } = await logger.flag({
        note: noteInput.value || undefined,
      });
      statusEl.textContent = `Saved: ${bugId}`;
      setTimeout(() => {
        toggle();
        submitBtn.disabled = false;
      }, 1500);
    } catch {
      statusEl.textContent = "Failed to send";
      submitBtn.disabled = false;
    }
  });

  // Keyboard shortcut: Ctrl+Shift+B
  function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.shiftKey && e.key === "B") {
      e.preventDefault();
      toggle();
    }
  }
  document.addEventListener("keydown", onKeyDown);

  document.body.appendChild(host);

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    host.remove();
  };
}
