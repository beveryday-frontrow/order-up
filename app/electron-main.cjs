const { app, BrowserWindow, shell, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");

const PORT = 3333;
let serverProcess = null;
let mainWindow = null;

/** Wait for the Express server to accept connections. */
function waitForServer(port, retries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function tryConnect() {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        attempts++;
        if (attempts >= retries) {
          reject(new Error("Server did not start in time"));
        } else {
          setTimeout(tryConnect, delay);
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        attempts++;
        if (attempts >= retries) {
          reject(new Error("Server did not start in time"));
        } else {
          setTimeout(tryConnect, delay);
        }
      });
      socket.connect(port, "127.0.0.1");
    }
    tryConnect();
  });
}

function startServer() {
  const fs = require("fs");

  // Resolve paths — in built app, unpacked files live in app.asar.unpacked/
  const tsxBin = path.join(__dirname, "node_modules", ".bin", "tsx");
  let serverScript = path.join(__dirname, "server.ts");
  const unpackedDir = __dirname.replace("app.asar", "app.asar.unpacked");
  const unpackedServer = path.join(unpackedDir, "server.ts");
  const unpackedTsxCli = path.join(unpackedDir, "node_modules", "tsx", "dist", "cli.cjs");

  if (fs.existsSync(unpackedServer)) {
    serverScript = unpackedServer;
  }

  let cmd, args;
  if (fs.existsSync(tsxBin)) {
    // Dev mode: tsx binary is directly available
    cmd = tsxBin;
    args = [serverScript];
  } else if (fs.existsSync(unpackedTsxCli)) {
    // Built app: use Electron's node with ELECTRON_RUN_AS_NODE + tsx cli
    cmd = process.execPath;
    args = [unpackedTsxCli, serverScript];
  } else {
    // Last resort: system node + tsx
    cmd = "node";
    args = ["--import", "tsx", serverScript];
  }

  console.log(`[server] Starting: ${cmd} ${args.join(" ")}`);

  serverProcess = spawn(cmd, args, {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => {
    process.stdout.write(`[server] ${data}`);
  });
  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(`[server] ${data}`);
  });
  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, "public", "images", "orderupapp.png");
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Order Up!",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f172a",
    icon: appIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set dock icon on macOS
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Handle external links (cursor://, https://, fork:// etc.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Intercept navigation to external protocols
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startServer();

  try {
    await waitForServer(PORT);
  } catch (e) {
    console.error("Failed to start server:", e.message);
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS, keep app running in dock
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Kill the Express server when the app quits
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
