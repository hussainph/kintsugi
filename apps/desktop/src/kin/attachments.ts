import type { Chip } from "../lib/chips.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const ATTACHMENT_ACCEPT = "image/*,.pdf,.md,.markdown,.txt";

export type AttachmentFile = Pick<File, "name" | "size" | "type" | "arrayBuffer">;

/** A quick client check; the backend validates the bytes and filename too. */
export function attachmentError(files: readonly AttachmentFile[], existing: number): string | null {
  if (existing + files.length > MAX_ATTACHMENTS) return "Up to 8 files per message.";
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) return "Each file must be 20 MiB or smaller.";
    if (!file.type.startsWith("image/") && !/\.(?:png|jpe?g|gif|webp|heic|heif|pdf|md|markdown|txt)$/i.test(file.name))
      return "Choose an image, PDF, Markdown or text file.";
  }
  return null;
}

/** Do not import or pin a file after its composer or vault has gone away. */
export async function importAttachmentFiles(
  files: readonly AttachmentFile[],
  current: () => boolean,
  importFile: (name: string, bytes: number[]) => Promise<Chip>,
  append: (chip: Chip) => void,
) {
  for (const file of files) {
    if (!current()) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!current()) return;
    const chip = await importFile(file.name, Array.from(bytes));
    if (!current()) return;
    append(chip);
  }
}

type AttachmentQueueOptions = {
  current: () => boolean;
  pendingCount: () => number;
  importFile: (name: string, bytes: number[]) => Promise<Chip>;
  append: (chip: Chip) => void;
  importing: (busy: boolean) => void;
  error: (error: unknown) => void;
};

/** One composer's imports: reserve on arrival, then read and import in order.
 * A new composer gets its own queue, without waiting for stale requests. */
export function createAttachmentQueue(options: AttachmentQueueOptions) {
  let reserved = 0;
  let tail = Promise.resolve();
  return {
    enqueue(files: readonly AttachmentFile[]): Promise<void> {
      if (!files.length || !options.current()) return Promise.resolve();
      const batch = [...files];
      const error = attachmentError(batch, options.pendingCount() + reserved);
      if (error) {
        options.error(error);
        return Promise.resolve();
      }
      reserved += batch.length;
      const done = tail.then(async () => {
        let remaining = batch.length;
        let failed = false;
        let failure: unknown;
        try {
          await importAttachmentFiles(batch, options.current, options.importFile, (chip) => {
            // Convert the reservation into a pinned chip before notifying listeners.
            reserved--;
            remaining--;
            options.append(chip);
          });
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          // Failed and cancelled files no longer occupy a slot; successes stay pinned.
          reserved -= remaining;
          if (options.current()) options.importing(reserved > 0);
        }
        if (failed && options.current()) options.error(failure);
      });
      tail = done;
      options.importing(true);
      return done;
    },
  };
}

export type Submission = { text: string; draft: string; chips: Chip[] };

type SendQueueOptions = {
  current: () => boolean;
  sending: (busy: boolean) => void;
  submit: (submission: Submission) => Promise<boolean>;
  accepted: (submission: Submission) => void;
  failed: (unsent: readonly Submission[], error?: unknown) => void;
};

/** Serialize Enter presses, not just IPC calls. Only the first submission owns
 * staged files; later text waits for its acceptance (and any new thread id). */
export function createComposerSendQueue(options: SendQueueOptions) {
  const pending: Submission[] = [];
  let running: Promise<void> | null = null;
  async function drain() {
    try {
      while (pending.length && options.current()) {
        const submission = pending[0]!;
        let ok = false;
        let failure: unknown;
        try { ok = await options.submit(submission); }
        catch (error) { failure = error; }
        if (!options.current()) return;
        if (!ok) {
          // Do not send later text after a failure or consume its staged files.
          options.failed(pending.splice(0), failure);
          return;
        }
        pending.shift();
        options.accepted(submission);
      }
    } finally {
      pending.length = 0;
      running = null;
      if (options.current()) options.sending(false);
    }
  }
  return {
    enqueue(submission: Submission): Promise<void> {
      if (!options.current()) return Promise.resolve();
      // A double Enter on a retained draft must not submit it twice.
      if (pending.some((item) => item.text === submission.text)) return running ?? Promise.resolve();
      pending.push({ ...submission, chips: running ? submission.chips.filter((chip) => chip.kind !== "attachment") : submission.chips });
      if (!running) {
        options.sending(true);
        const started = drain();
        // submit can throw before its first await. drain then finishes
        // synchronously, so do not replace its cleared state with a stale promise.
        if (pending.length) running = started;
        return started;
      }
      return running;
    },
  };
}

/** A failed burst returns every unsent text to the field, including newer edits.
 * A single failed submit leaves the draft exactly as the writer has it. */
export function failedSubmissionDraft(unsent: readonly Submission[], draft: string): string {
  if (unsent.length < 2) return draft;
  const texts = unsent.map((submission) => submission.text).filter(Boolean);
  if (draft.trim() && draft !== unsent.at(-1)?.draft && !texts.includes(draft.trim())) texts.push(draft);
  return texts.join("\n\n");
}

/** File references retain their extension when staging becomes thread storage. */
export const imageAttachment = (chip: Chip) => chip.kind === "attachment" && /\.(?:png|jpe?g|gif|webp|heic|heif)$/i.test(chip.path);

export type ImageAlternative = { name: string; usable: boolean; enabled: boolean; images: boolean };

/** Only warn about image files, and only when the selected model is known. */
export function imageModelWarning(chips: readonly Chip[], images: boolean | undefined, alternatives: readonly ImageAlternative[]): string | null {
  if (images !== false || !chips.some(imageAttachment)) return null;
  const available = alternatives.filter((model) => model.usable && model.images);
  const enabled = available.find((model) => model.enabled);
  const alternative = enabled ?? available[0];
  if (!alternative) return "This model can’t view images.";
  return enabled ? `This model can’t view images. Try ${alternative.name}.` : `This model can’t view images. Enable ${alternative.name}.`;
}

/** Backend errors can include line breaks; attachment failures stay one line. */
export const attachmentFailure = (error: unknown) => String(error).replace(/\s+/g, " ").trim();
