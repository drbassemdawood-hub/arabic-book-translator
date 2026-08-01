/* Anthropic API from the browser.
 *
 * The key and the book text go straight from this browser to
 * api.anthropic.com — there is no server in between. Direct browser access
 * is enabled with the `anthropic-dangerous-direct-browser-access` header
 * ("dangerous" refers to embedding a key in a public site's code, which this
 * app never does: the user brings their own key).
 */

const API_BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 8; // an hours-long run must ride out rate limits and blips

export class ApiError extends Error {
  constructor(status, type, message, retryAfter = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter; // seconds, from a 429/503 Retry-After header
  }
}

/** The safety classifier declined a single request (HTTP 200 + refusal). */
export class RefusalError extends Error {
  constructor() {
    super("The model declined this passage (safety refusal).");
    this.name = "RefusalError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

function baseHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function throwApiError(resp) {
  let type = "api_error";
  let message = `HTTP ${resp.status}`;
  try {
    const body = await resp.json();
    if (body && body.error) {
      type = body.error.type || type;
      message = body.error.message || message;
    }
  } catch {
    /* non-JSON error body */
  }
  const ra = parseFloat(resp.headers.get("retry-after"));
  throw new ApiError(resp.status, type, message, Number.isFinite(ra) ? ra : null);
}

/** One streaming /v1/messages request. Returns { text, stopReason }. */
async function streamOnce(apiKey, model, system, content, onDelta) {
  const resp = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: baseHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 64000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      stream: true,
    }),
  });
  if (!resp.ok) await throwApiError(resp);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason = null;

  const handleEvent = (data) => {
    if (data === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
      text += ev.delta.text;
      if (onDelta) onDelta(ev.delta.text);
    } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
      stopReason = ev.delta.stop_reason;
    } else if (ev.type === "error") {
      const err = ev.error || {};
      // mid-stream error event (e.g. overloaded) — surface like an HTTP error
      throw new ApiError(err.type === "overloaded_error" ? 529 : 500, err.type || "api_error",
        err.message || "stream error");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the trailing partial line
    for (const line of lines) {
      if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
    }
  }
  return { text, stopReason };
}

function retryable(err) {
  if (err instanceof ApiError) {
    return err.status === 429 || err.status === 408 || err.status >= 500; // incl. 529 overloaded
  }
  if (err instanceof TypeError) return true; // fetch network failure / dropped stream
  return err instanceof Error && err.name !== "AbortError" &&
    /network|fetch|load failed|connection/i.test(err.message || "");
}

async function cancellableSleep(seconds, isCancelled) {
  for (let i = 0; i < seconds; i++) {
    if (isCancelled()) throw new CancelledError();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * One model call with retries — covers both request establishment and
 * mid-stream connection drops (a book translation must survive an unstable
 * overnight connection on its own).
 */
export async function callModel(apiKey, model, system, content, { isCancelled, log }) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (isCancelled()) throw new CancelledError();
    try {
      const { text, stopReason } = await streamOnce(apiKey, model, system, content);
      if (stopReason === "refusal") throw new RefusalError();
      if (stopReason === "max_tokens") {
        log("  ⚠ warning: output hit the token limit; passage may be truncated");
      }
      return text.trim();
    } catch (err) {
      if (err instanceof RefusalError || err instanceof CancelledError) throw err;
      if (!retryable(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      lastError = err;
      let delay = Math.min(5 * 2 ** attempt, 120);
      if (err instanceof ApiError && err.retryAfter) delay = Math.max(delay, Math.ceil(err.retryAfter));
      const label = err instanceof ApiError ? `API ${err.status} (${err.type})` : "connection error";
      log(`  ⚠ ${label} — retrying in ${delay}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await cancellableSleep(delay, isCancelled);
    }
  }
  throw lastError;
}

/** Token count for the cost estimate (best-effort). */
export async function countTokens(apiKey, model, sampleText) {
  const resp = await fetch(`${API_BASE}/messages/count_tokens`, {
    method: "POST",
    headers: baseHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: sampleText }],
    }),
  });
  if (!resp.ok) await throwApiError(resp);
  const body = await resp.json();
  return body.input_tokens;
}

/** Vision content block for OCR of one scanned page. */
export function imageContent(pngBase64, prompt) {
  return [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBase64 },
    },
    { type: "text", text: prompt },
  ];
}
