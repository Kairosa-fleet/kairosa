"use client";

import { FileText, ImagePlus, Upload, User } from "lucide-react";
import { useState } from "react";

import { AuthedImage, openAuthedFile } from "@/components/AuthedFile";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";

/**
 * Attaching scans and photographs to a record.
 *
 * Shared by vehicles and drivers because the rules are identical in both: a
 * recorded document is only useful if the certificate itself can be produced,
 * and uploading happens on selection so a rejected file is reported next to
 * the row the operator is looking at rather than after a long form.
 */

/** What a form tracks per document row while it is being filled in. */
export type DocDraft = {
  number: string;
  expiresOn: string;
  fileUrl: string;
  fileName: string;
  uploading: boolean;
  error: string | null;
};

export const EMPTY_DOC: DocDraft = {
  number: "",
  expiresOn: "",
  fileUrl: "",
  fileName: "",
  uploading: false,
  error: null,
};

/**
 * Downscale a photograph before upload.
 *
 * A phone camera produces 4–8 MB files and a depot's connection is usually
 * the worst part of the whole system, so sending the original makes the form
 * feel broken. 1600px is more than enough to identify a truck, read a number
 * plate, or recognise a face.
 */
export async function shrinkImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    // A format the browser cannot decode still uploads — the server decides.
    return file;
  }
}

/**
 * The PDF slot for one document row.
 *
 * The real `<input type="file">` is hidden behind a label: it is styled
 * inconsistently across browsers and gives no feedback once a file is chosen,
 * so this renders the three states that matter — empty, uploading, attached.
 */
export function DocumentUpload({
  id,
  doc,
  onPick,
  onClear,
  label = "Attach scanned PDF",
  invalid = false,
}: {
  id: string;
  doc: DocDraft;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
  label?: string;
  /** Draw a red border + message when this scan is required but missing. */
  invalid?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {doc.fileUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-[var(--success-soft)] px-3 py-2">
          <FileText size={14} className="shrink-0 text-[var(--success)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--success)]">
            {doc.fileName}
          </span>
          <button
            type="button"
            onClick={() => void openAuthedFile(doc.fileUrl)}
            className="text-xs font-medium text-[var(--success)] underline"
          >
            View
          </button>
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-[var(--ink-2)] hover:underline"
          >
            Replace
          </button>
        </div>
      ) : (
        <label
          htmlFor={`file-${id}`}
          id={`docfile-${id}`}
          tabIndex={-1}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-dashed px-3 py-2.5 text-sm transition-colors outline-none",
            invalid ? "border-[var(--danger)]" : "border-[var(--stroke)]",
            doc.uploading
              ? "opacity-60"
              : "hover:border-[var(--accent)] hover:bg-[var(--surface)]",
          )}
        >
          <Upload size={14} className="shrink-0 text-[var(--ink-2)]" aria-hidden />
          <span className="text-[var(--ink-2)]">
            {doc.uploading ? "Uploading…" : label}
          </span>
          <input
            id={`file-${id}`}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            disabled={doc.uploading}
            onChange={(e) => {
              onPick(e.target.files?.[0]);
              // Reset so picking the same file again still fires onChange.
              e.target.value = "";
            }}
          />
        </label>
      )}
      {doc.error ? (
        <p className="text-xs text-[var(--danger)]">{doc.error}</p>
      ) : invalid ? (
        <p className="text-xs text-[var(--danger)]">Attach the scanned PDF.</p>
      ) : null}
    </div>
  );
}

/**
 * A single photograph — a driver's headshot rather than a gallery.
 *
 * Shown as a round preview because that is what it is used for: recognising
 * the person at the gate, and putting a face to a name on the dispatch board.
 */
export function PhotoUpload({
  fileUrl,
  fileName,
  onUploaded,
  onClear,
}: {
  fileUrl: string;
  fileName: string;
  onUploaded: (result: { fileUrl: string; fileName: string }) => void;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await api.uploadDocument(await shrinkImage(file));
      onUploaded({ fileUrl: stored.fileUrl, fileName: stored.fileName });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that photo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      {fileUrl ? (
        <AuthedImage
          fileUrl={fileUrl}
          alt="Driver photo"
          className="size-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="flex size-20 shrink-0 items-center justify-center rounded-full bg-[var(--surface)]">
          <User size={26} className="text-[var(--ink-3)]" aria-hidden />
        </div>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor="driver-photo"
          className={cn(
            "inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-[var(--stroke)] px-3 py-2 text-sm transition-colors",
            busy ? "opacity-60" : "hover:border-[var(--accent)] hover:bg-[var(--surface)]",
          )}
        >
          <ImagePlus size={14} className="shrink-0 text-[var(--ink-2)]" aria-hidden />
          <span className="text-[var(--ink-2)]">
            {busy ? "Uploading…" : fileUrl ? "Replace photo" : "Add a photo"}
          </span>
          <input
            id="driver-photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        {fileUrl && (
          <div className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
            <span className="max-w-[12rem] truncate">{fileName}</span>
            <button type="button" onClick={onClear} className="text-[var(--danger)] hover:underline">
              Remove
            </button>
          </div>
        )}
        {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}
