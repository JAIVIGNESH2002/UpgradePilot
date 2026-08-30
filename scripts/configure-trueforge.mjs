const DEFAULT_TRUEFORGE_BASE_URL = "http://localhost:8790";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const env = process.env;
const trueforgeBaseUrl = stripTrailingSlash(env.TRUEFORGE_BASE_URL ?? DEFAULT_TRUEFORGE_BASE_URL);

await waitForTrueForge();
await configureDaytonaProvider();
await configureGeminiProvider();

async function waitForTrueForge() {
  const deadline = Date.now() + readPositiveInt("TRUEFORGE_CONFIGURE_TIMEOUT_MS", 120_000);
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${trueforgeBaseUrl}/healthz`);

      if (response.ok) {
        console.log(`TrueForge is reachable at ${trueforgeBaseUrl}.`);
        return;
      }

      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await wait(2_000);
  }

  throw new Error(
    `TrueForge did not become reachable at ${trueforgeBaseUrl}: ${errorMessage(lastError)}`
  );
}

async function configureDaytonaProvider() {
  const apiKey = env.DAYTONA_API_KEY?.trim();

  if (!apiKey) {
    console.log("DAYTONA_API_KEY is not set; skipping Daytona sandbox provider configuration.");
    return;
  }

  await putJson("/api/v1/settings/sandbox-providers", {
    manifest: {
      type: "daytona",
      auth: { api_key: apiKey },
      exec_timeout_ms: readPositiveInt("DAYTONA_EXEC_TIMEOUT_MS", 600_000),
      auto_stop_interval_in_minutes: readNonNegativeInt("DAYTONA_AUTO_STOP_MINUTES", 5),
      auto_archive_interval_in_minutes: readNonNegativeInt("DAYTONA_AUTO_ARCHIVE_MINUTES", 60),
      auto_delete_interval_in_minutes: readNonNegativeInt("DAYTONA_AUTO_DELETE_MINUTES", 7_200),
      resources: readDaytonaResources()
    }
  });

  console.log("Configured TrueForge Daytona sandbox provider.");
}

async function configureGeminiProvider() {
  const apiKey = env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    console.log("GEMINI_API_KEY is not set; skipping Gemini model provider configuration.");
    return;
  }

  const modelName = env.TRUEFORGE_GEMINI_MODEL_NAME?.trim() || "gemini-2.5-flash";
  const modelId = env.TRUEFORGE_GEMINI_MODEL_ID?.trim() || modelName;

  await putJson("/api/v1/settings/model-providers", {
    manifest: {
      type: "google-gemini",
      base_url: env.TRUEFORGE_GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
      auth: { api_key: apiKey },
      models: [
        {
          model_id: modelId,
          name: modelName,
          properties: {
            reasoning_efforts: ["low"],
            max_output_tokens: readPositiveInt("TRUEFORGE_REPAIR_MAX_TOKENS", 2_400)
          }
        }
      ]
    }
  });

  console.log(
    `Configured TrueForge Gemini model provider with model name google-gemini/${modelName}.`
  );
}

async function putJson(path, body) {
  const response = await fetch(`${trueforgeBaseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
}

function readDaytonaResources() {
  const resources = {
    cpu: readOptionalPositiveNumber("DAYTONA_RESOURCE_CPU"),
    memory: readOptionalPositiveNumber("DAYTONA_RESOURCE_MEMORY"),
    disk: readOptionalPositiveNumber("DAYTONA_RESOURCE_DISK")
  };
  const present = Object.fromEntries(
    Object.entries(resources).filter(([, value]) => value !== undefined)
  );

  return Object.keys(present).length > 0 ? present : undefined;
}

function readOptionalPositiveNumber(name) {
  const rawValue = env[name]?.trim();

  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

function readPositiveInt(name, defaultValue) {
  const rawValue = env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readNonNegativeInt(name, defaultValue) {
  const rawValue = env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function wait(durationMs) {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
