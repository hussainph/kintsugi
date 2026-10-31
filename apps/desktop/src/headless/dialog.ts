// In-page stand-ins for native dialogs in headless dev. Browser tabs driven by
// automation may refuse `window.prompt` ("prompt() is not supported"), and
// blocking dialogs are invisible to an accessibility snapshot, so these are
// ordinary DOM: a modal <dialog> with a labelled field and buttons.

type Spec = { message: string; input?: string; ok: string; cancel?: string };

function show({ message, input, ok, cancel }: Spec): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", message.split("\n")[0]);
    dialog.dataset.headlessDialog = "";

    const form = document.createElement("form");
    form.method = "dialog";

    const text = document.createElement("label");
    text.style.whiteSpace = "pre-wrap";
    text.textContent = message;
    form.append(text);

    let field: HTMLInputElement | null = null;
    if (input !== undefined) {
      field = document.createElement("input");
      field.type = "text";
      field.value = input;
      field.autocomplete = "off";
      field.spellcheck = false;
      text.append(field);
    }

    const buttons = document.createElement("div");
    buttons.className = "ki-headless-actions";
    const button = (label: string, value: string) => {
      const b = document.createElement("button");
      b.type = "submit";
      b.value = value;
      b.textContent = label;
      buttons.append(b);
      return b;
    };
    if (cancel !== undefined) button(cancel, "cancel");
    const okButton = button(ok, "ok");
    form.append(buttons);
    dialog.append(form);

    // Escape fires `cancel`, then `close` with an empty returnValue.
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "ok";
      dialog.remove();
      resolve(accepted ? (field ? field.value : "ok") : null);
    });
    // Enter in the field submits as OK, not as the first (cancel) button.
    field?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dialog.close("ok");
      }
    });

    // A native modal enters the top layer without losing inherited theme values.
    (document.querySelector(".graphical-theme") ?? document.body).append(dialog);
    dialog.showModal();
    (field ?? okButton).focus();
  });
}

export const domPrompt = (message: string, value: string) => show({ message, input: value, ok: "OK", cancel: "Cancel" });
export const domAlert = async (message: string) => void (await show({ message, ok: "OK" }));
export const domConfirm = async (message: string) =>
  (await show({ message, ok: "OK", cancel: "Cancel" })) !== null;
