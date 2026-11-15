import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

/** PUTs the file at `filePath` to `url` and resolves with the HTTP status. */
export type UploadFile = (
  url: string,
  headers: Record<string, string>,
  filePath: string,
  bytes: number,
) => Promise<number>;

/**
 * Streams a file from disk with its exact length, so a multi-gigabyte room file never sits in memory
 * and signed storage addresses (which need Content-Length) accept it.
 */
export const uploadFileStreaming: UploadFile = (url, headers, filePath, bytes) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "PUT",
      headers: { ...headers, "content-length": String(bytes) },
    });
    request.setTimeout(10 * 60_000, () => request.destroy(new Error("upload timed out")));
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    const source = fs.createReadStream(filePath);
    source.on("error", (error) => request.destroy(error));
    source.pipe(request);
  });
