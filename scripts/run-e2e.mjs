import { spawn } from "node:child_process";

const baseUrl = "http://127.0.0.1:3000";
const startupTimeoutMs = 120_000;

const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3000"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }
);

server.stdout.on("data", (chunk) => {
  process.stdout.write(`[WebServer] ${chunk}`);
});

server.stderr.on("data", (chunk) => {
  process.stderr.write(`[WebServer] ${chunk}`);
});

let exitCode = 1;

try {
  await waitForServer(baseUrl, startupTimeoutMs);
  exitCode = await runPlaywright();
} finally {
  await stopServer();
}

process.exit(exitCode);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next server exited early with code ${server.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function runPlaywright() {
  return new Promise((resolve) => {
    let output = "";
    let summaryTimer;
    let settled = false;
    const testProcess = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const finish = (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(summaryTimer);
      resolve(code);
    };

    const handleOutput = (stream, chunk) => {
      const text = chunk.toString();
      output += text;
      stream.write(chunk);

      const failed = /^\s+\d+\s+failed/m.test(output);
      const passed = /^\s+\d+\s+passed\s+\(/m.test(output);

      if ((failed || passed) && summaryTimer === undefined) {
        summaryTimer = setTimeout(async () => {
          await stopProcessTree(testProcess);
          finish(failed ? 1 : 0);
        }, 2_000);
      }
    };

    testProcess.stdout.on("data", (chunk) => {
      handleOutput(process.stdout, chunk);
    });

    testProcess.stderr.on("data", (chunk) => {
      handleOutput(process.stderr, chunk);
    });

    testProcess.on("close", (code, signal) => {
      if (code !== null) {
        finish(code);
        return;
      }

      finish(signal ? 1 : 0);
    });
  });
}

async function stopServer() {
  if (server.exitCode !== null || server.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    await stopProcessTree(server);
    return;
  }

  server.kill("SIGTERM");

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5_000);

    server.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function stopProcessTree(processToStop) {
  if (processToStop.pid === undefined) {
    return Promise.resolve();
  }

  if (process.platform !== "win32") {
    processToStop.kill("SIGTERM");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(processToStop.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.on("exit", resolve);
  });
}
