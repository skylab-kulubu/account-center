import "server-only";

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "Request body is too large." : "Invalid request body.");
    this.name = "RequestBodyError";
  }
}

/**
 * Reads the whole request body as bytes while enforcing an identity encoding
 * and a hard byte cap, rejecting early on a declared length above the cap and
 * cancelling the stream as soon as the cap is exceeded.
 */
export async function readBytesBody(
  request: Request,
  options: { maxBytes: number; contentType?: (value: string) => boolean },
) {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (options.contentType !== undefined && !options.contentType(contentType)) {
    throw new RequestBodyError(400);
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") throw new RequestBodyError(400);

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new RequestBodyError(400);
    if (Number(declaredLength) > options.maxBytes) throw new RequestBodyError(413);
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > options.maxBytes) {
        await reader.cancel();
        throw new RequestBodyError(413);
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readUtf8Body(
  request: Request,
  options: { maxBytes: number; exactContentType?: string },
) {
  const body = await readBytesBody(request, {
    maxBytes: options.maxBytes,
    contentType: options.exactContentType === undefined
      ? undefined
      : (value) => value === options.exactContentType,
  });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestBodyError(400);
  }
}

export async function readUrlEncodedBody(
  request: Request,
  options: { maxBytes: number; exactContentType?: boolean },
) {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  const acceptedContentType = options.exactContentType
    ? contentType === "application/x-www-form-urlencoded"
    : contentType.split(";", 1)[0]?.trim() === "application/x-www-form-urlencoded";
  if (!acceptedContentType) {
    throw new RequestBodyError(400);
  }
  return new URLSearchParams(await readUtf8Body(request, { maxBytes: options.maxBytes }));
}
