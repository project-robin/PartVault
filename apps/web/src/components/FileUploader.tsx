import { useDropzone } from "react-dropzone";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch, sha256Of } from "../lib/api";
import { planParts } from "@partvault/shared";

interface UploadPartResult {
  partNumber: number;
  url: string;
}

interface InitiateResult {
  fileId: string;
  uploadId: string;
  s3Key: string;
  parts: UploadPartResult[];
}

interface FileProgress {
  fileId: string;
  fileName: string;
  totalParts: number;
  doneParts: number;
  status: "uploading" | "completing" | "done" | "error";
  error?: string;
}

export function FileUploader({ partNumber, revision }: { partNumber: string; revision: string }) {
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const queryClient = useQueryClient();

  const onDrop = async (acceptedFiles: File[]) => {
    for (const file of acceptedFiles) {
      const sha256 = await sha256Of(file);
      const init = await apiFetch<InitiateResult>(`/parts/${partNumber}/revisions/${revision}/files/initiate`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type || "application/octet-stream", sha256 }),
      });

      const fp: FileProgress = { fileId: init.fileId, fileName: file.name, totalParts: init.parts.length, doneParts: 0, status: "uploading" };
      setProgress((p) => [...p, fp]);

      const completedParts: { eTag: string; partNumber: number }[] = [];
      try {
        for (const part of init.parts) {
          const slice = file.slice((part.partNumber - 1) * 8 * 1024 * 1024, part.partNumber * 8 * 1024 * 1024);
          const res = await fetch(part.url, { method: "PUT", body: slice });
          if (!res.ok) throw new Error(`Part ${part.partNumber} upload failed: ${res.status}`);
          const eTag = res.headers.get("ETag")?.replace(/"/g, "") ?? "";
          completedParts.push({ eTag, partNumber: part.partNumber });
          setProgress((p) => p.map((x) => x.fileId === init.fileId ? { ...x, doneParts: completedParts.length } : x));
        }
        setProgress((p) => p.map((x) => x.fileId === init.fileId ? { ...x, status: "completing" } : x));
        await apiFetch(`/parts/${partNumber}/revisions/${revision}/files/${init.fileId}/complete`, {
          method: "POST",
          body: JSON.stringify({ uploadId: init.uploadId, parts: completedParts }),
        });
        setProgress((p) => p.map((x) => x.fileId === init.fileId ? { ...x, status: "done" } : x));
        queryClient.invalidateQueries({ queryKey: ["files", partNumber, revision] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setProgress((p) => p.map((x) => x.fileId === init.fileId ? { ...x, status: "error" as const, error: msg } : x));
      }
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, multiple: true });

  return (
    <div>
      <div {...getRootProps()} role="button" aria-label="Upload files" className={`border-2 border-dashed p-6 text-center cursor-pointer ${isDragActive ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}>
        <input {...getInputProps()} aria-label="File input" />
        {isDragActive ? <p>Drop files here... (up to 2 GB)</p> : <p>Drag &amp; drop CAD files here, or click to select (up to 2 GB)</p>}
      </div>
      {progress.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label="Upload progress">
          {progress.map((p) => (
            <li key={p.fileId} className="text-sm">
              <span className="font-medium">{p.fileName}</span> — {p.status}
              {p.status === "uploading" && ` (${p.doneParts}/${p.totalParts} parts)`}
              {p.error && <span className="text-red-600">: {p.error}</span>}
              {p.status !== "error" && p.status !== "done" && (
                <div className="h-2 bg-gray-200 rounded mt-1" role="progressbar" aria-valuenow={p.doneParts} aria-valuemax={p.totalParts}>
                  <div className="h-2 bg-blue-500 rounded" style={{ width: `${(p.doneParts / p.totalParts) * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
