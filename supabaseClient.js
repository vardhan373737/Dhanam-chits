require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
}

const RETRY_ATTEMPTS = Number(process.env.SUPABASE_FETCH_RETRIES || 2);
const RETRY_BASE_DELAY_MS = Number(process.env.SUPABASE_FETCH_RETRY_BASE_MS || 300);
const RETRY_MAX_DELAY_MS = Number(process.env.SUPABASE_FETCH_RETRY_MAX_MS || 2000);
const REQUEST_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS || 10000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  const message = [
    error?.message,
    error?.cause?.message,
    error?.code,
    error?.cause?.code,
    error?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("und_err") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("enotfound") ||
    message.includes("aborterror")
  );
}

function createRetryingFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node runtime.");
  }

  return async function retryingFetch(input, init = {}) {
    let lastError;

    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(input, {
          ...init,
          signal: timeoutController.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;

        const shouldRetry = attempt < RETRY_ATTEMPTS && isRetryableNetworkError(error);
        if (!shouldRetry) {
          break;
        }

        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
        await sleep(delay);
      }
    }

    throw lastError;
  };
}

// Service role is required for trusted server-side operations.
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  global: {
    fetch: createRetryingFetch(),
  },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

module.exports = supabase;
