import type { UploadTransfer } from "./workspaceUploadRun";

const BASE_TIMEOUT_MS = 2 * 60_000;
// Assume at least 256 KB/s so a 2 GB file on a slow link is not cut off by a fixed timeout.
const MIN_BYTES_PER_SECOND = 256 * 1024;

export function sendUploadBytes(
  url: string,
  file: Blob,
  onProgress: (loadedBytes: number) => void,
): UploadTransfer {
  const xhr = new XMLHttpRequest();
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    xhr.open("POST", url, true);
    xhr.timeout = BASE_TIMEOUT_MS + Math.ceil((file.size / MIN_BYTES_PER_SECOND) * 1000);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    xhr.addEventListener("load", () => resolve({ status: xhr.status, body: xhr.responseText }));
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
