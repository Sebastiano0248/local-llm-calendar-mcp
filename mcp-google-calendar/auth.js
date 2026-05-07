import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";
import open from "open";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dir, "credentials", "credentials.json");
const TOKEN_PATH = join(__dir, "credentials", "token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
];

if (!existsSync(CREDS_PATH)) {
  console.error("ERROR: No se encontró credentials.json en la carpeta credentials/");
  console.error("Sigue las instrucciones del README para obtenerlo de Google Cloud Console.");
  process.exit(1);
}

const { installed } = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
const oauth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
  "http://localhost:3456/callback"
);

const authUrl = oauth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3456");
  if (url.pathname !== "/callback") return;

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No se recibió código de autorización.");
    return;
  }

  const { tokens } = await oauth2Client.getToken(code);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h2>Autenticación completada. Puedes cerrar esta ventana.</h2>");
  server.close();
  console.log("Token guardado en credentials/token.json");
  console.log("Ya puedes usar el servidor MCP.");
  process.exit(0);
});

server.listen(3456, () => {
  console.log("Abriendo navegador para autenticación con Google...");
  open(authUrl);
});
