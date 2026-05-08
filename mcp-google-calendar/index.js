import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { z } from "zod";

const __dir = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dir, "credentials", "credentials.json");
const TOKEN_PATH = join(__dir, "credentials", "token.json");

function getAuth() {
  if (!existsSync(CREDS_PATH) || !existsSync(TOKEN_PATH)) {
    throw new Error("Faltan credenciales. Ejecuta: npm run auth");
  }
  const { installed } = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  const tokens = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  const auth = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  auth.setCredentials(tokens);
  return auth;
}

function parseDate(s) {
  if (!s || s === "today") return new Date();
  if (s === "tomorrow") return new Date(Date.now() + 86400000);
  const daysAgo = s.match(/^(\d+)\s*days?\s*ago$/i);
  if (daysAgo) return new Date(Date.now() - parseInt(daysAgo[1]) * 86400000);
  const weeksAgo = s.match(/^(\d+)\s*weeks?\s*ago$/i);
  if (weeksAgo) return new Date(Date.now() - parseInt(weeksAgo[1]) * 7 * 86400000);
  const monthsAgo = s.match(/^(\d+)\s*months?\s*ago$/i);
  if (monthsAgo) return new Date(Date.now() - parseInt(monthsAgo[1]) * 30 * 86400000);
  const d = new Date(s);
  if (isNaN(d)) throw new Error(`Fecha no reconocida: "${s}". Usa 'today', 'Xdaysago', 'Xweeksago' o fecha ISO (ej. 2026-04-01).`);
  return d;
}

function formatEvent(e) {
  const start = e.start?.dateTime ?? e.start?.date ?? "Sin fecha";
  const end = e.end?.dateTime ?? e.end?.date ?? "";
  const loc = e.location ? `\n  Lugar: ${e.location}` : "";
  const desc = e.description ? `\n  Descripción: ${e.description.slice(0, 300)}` : "";
  const attendees = e.attendees?.length ? `\n  Asistentes: ${e.attendees.map(a => a.displayName ?? a.email).join(", ")}` : "";
  return `• ${e.summary ?? "(Sin título)"} [ID: ${e.id}]\n  Inicio: ${start}\n  Fin: ${end}${loc}${attendees}${desc}`;
}

function formatTask(t) {
  const due = t.due ? `\n  Vence: ${t.due.slice(0, 10)}` : "";
  const status = t.status === "completed" ? " ✓" : "";
  const notes = t.notes ? `\n  Notas: ${t.notes.slice(0, 200)}` : "";
  return `• ${t.title ?? "(Sin título)"}${status} [ID: ${t.id}]${due}${notes}`;
}

const server = new McpServer({ name: "google-calendar", version: "2.0.0" });
const calendar = google.calendar({ version: "v3" });
const tasks = google.tasks({ version: "v1" });

// ── UTILIDADES ────────────────────────────────────────────────────────────────

server.tool(
  "get_current_datetime",
  "Devuelve la fecha y hora actuales. Llama esto siempre al inicio de la conversación para saber qué día es.",
  {},
  async () => {
    const now = new Date();
    const days = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
    const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const text = [
      `Fecha: ${days[now.getDay()]}, ${now.getDate()} de ${months[now.getMonth()]} de ${now.getFullYear()}`,
      `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`,
      `ISO: ${now.toISOString()}`,
      `Zona horaria: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── CALENDAR ──────────────────────────────────────────────────────────────────

server.tool(
  "list_calendars",
  "Lista todos los calendarios disponibles en la cuenta de Google",
  {},
  async () => {
    const auth = getAuth();
    const res = await calendar.calendarList.list({ auth });
    const items = res.data.items ?? [];
    const text = items.map(c => `• ${c.summary} [ID: ${c.id}]`).join("\n") || "No hay calendarios.";
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "list_events",
  "Lista eventos de un calendario en un rango de fechas. Permite buscar por texto y ver eventos pasados.",
  {
    calendarId: z.string().default("primary").describe("ID del calendario ('primary' para el principal)"),
    startDate: z.string().default("today").describe("Fecha de inicio: 'today', 'tomorrow', o fecha ISO (ej. 2026-04-01)"),
    endDate: z.string().optional().describe("Fecha de fin: 'today', 'tomorrow', o fecha ISO (ej. 2026-05-07). Si no se indica, usa startDate + days"),
    days: z.number().int().min(1).max(365).default(7).describe("Días desde startDate si no se especifica endDate"),
    query: z.string().optional().describe("Texto para filtrar eventos por título o descripción"),
    maxResults: z.number().int().min(1).max(100).default(25).describe("Número máximo de eventos"),
    includePast: z.boolean().default(true).describe("Si incluir eventos pasados. Por defecto true para no perder historial."),
    format: z.enum(["text", "json"]).default("text").describe("Formato de respuesta: 'text' legible o 'json' para cálculos (incluye start, end, summary, duration_minutes)"),
  },
  async ({ calendarId, startDate, endDate, days, query, maxResults, includePast, format }) => {
    const auth = getAuth();
    let timeMin = parseDate(startDate);
    if (!includePast && timeMin < new Date()) timeMin = new Date();

    const timeMax = endDate ? parseDate(endDate) : new Date(timeMin.getTime() + days * 86400000);

    const res = await calendar.events.list({
      auth, calendarId, maxResults, singleEvents: true, orderBy: "startTime",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      ...(query ? { q: query } : {}),
    });
    const items = res.data.items ?? [];
    if (!items.length) return { content: [{ type: "text", text: "No hay eventos en ese período." }] };

    if (format === "json") {
      const data = items.map(e => {
        const start = e.start?.dateTime ?? e.start?.date;
        const end = e.end?.dateTime ?? e.end?.date;
        const duration_minutes = (start && end)
          ? Math.round((new Date(end) - new Date(start)) / 60000)
          : null;
        return { id: e.id, summary: e.summary ?? null, start, end, duration_minutes, location: e.location ?? null, description: e.description ?? null };
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    return { content: [{ type: "text", text: items.map(formatEvent).join("\n\n") }] };
  }
);

server.tool(
  "get_today_events",
  "Devuelve todos los eventos de hoy en el calendario principal (o el que se indique)",
  {
    calendarId: z.string().default("primary").describe("ID del calendario"),
  },
  async ({ calendarId }) => {
    const auth = getAuth();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const res = await calendar.events.list({
      auth, calendarId, singleEvents: true, orderBy: "startTime",
      timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: 50,
    });
    const items = res.data.items ?? [];
    if (!items.length) return { content: [{ type: "text", text: "No tienes eventos hoy." }] };
    return { content: [{ type: "text", text: items.map(formatEvent).join("\n\n") }] };
  }
);

server.tool(
  "get_event",
  "Obtiene los detalles completos de un evento específico por su ID",
  {
    calendarId: z.string().default("primary").describe("ID del calendario"),
    eventId: z.string().describe("ID del evento (obtenido de list_events o search_events)"),
  },
  async ({ calendarId, eventId }) => {
    const auth = getAuth();
    const res = await calendar.events.get({ auth, calendarId, eventId });
    const e = res.data;
    const lines = [
      `Título: ${e.summary ?? "(Sin título)"}`,
      `Inicio: ${e.start?.dateTime ?? e.start?.date}`,
      `Fin: ${e.end?.dateTime ?? e.end?.date}`,
      e.location ? `Lugar: ${e.location}` : null,
      e.description ? `Descripción: ${e.description}` : null,
      e.attendees?.length ? `Asistentes:\n${e.attendees.map(a => `  - ${a.displayName ?? a.email} (${a.responseStatus})`).join("\n")}` : null,
      e.recurrence ? `Recurrencia: ${e.recurrence.join(", ")}` : null,
      e.status ? `Estado: ${e.status}` : null,
      e.htmlLink ? `Enlace: ${e.htmlLink}` : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "search_events",
  "Busca eventos por texto en uno o todos los calendarios, incluyendo el pasado",
  {
    query: z.string().describe("Texto a buscar en títulos, descripciones y lugares"),
    calendarId: z.string().default("all").describe("ID del calendario, o 'all' para buscar en todos"),
    maxResults: z.number().int().min(1).max(100).default(25).describe("Máximo de resultados por calendario"),
    startDate: z.string().default("30daysago").describe("Inicio de búsqueda: 'today', '30daysago', o fecha ISO (ej. 2026-04-01)"),
    days: z.number().int().min(1).max(365).default(30).describe("Días desde startDate"),
    format: z.enum(["text", "json"]).default("text").describe("Formato: 'text' legible o 'json' con duration_minutes para cálculos"),
  },
  async ({ query, calendarId, maxResults, startDate, days, format }) => {
    const auth = getAuth();
    const timeMin = parseDate(startDate).toISOString();
    const timeMax = new Date(new Date(timeMin).getTime() + days * 86400000).toISOString();

    let calendarIds = [calendarId];
    if (calendarId === "all") {
      const listRes = await calendar.calendarList.list({ auth });
      calendarIds = (listRes.data.items ?? []).map(c => c.id);
    }

    const results = [];
    for (const cid of calendarIds) {
      const res = await calendar.events.list({
        auth, calendarId: cid, q: query, maxResults, singleEvents: true,
        timeMin, timeMax,
      });
      results.push(...(res.data.items ?? []).map(e => ({ ...e, _calendarId: cid })));
    }

    if (!results.length) return { content: [{ type: "text", text: `No se encontraron eventos con "${query}".` }] };

    if (format === "json") {
      const data = results.map(e => {
        const start = e.start?.dateTime ?? e.start?.date;
        const end = e.end?.dateTime ?? e.end?.date;
        const duration_minutes = (start && end)
          ? Math.round((new Date(end) - new Date(start)) / 60000)
          : null;
        return { id: e.id, summary: e.summary ?? null, start, end, duration_minutes, calendarId: e._calendarId };
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    return { content: [{ type: "text", text: results.map(formatEvent).join("\n\n") }] };
  }
);

server.tool(
  "get_free_busy",
  "Consulta los intervalos ocupados y libres en un rango de fechas",
  {
    startDate: z.string().default("today").describe("Inicio del rango: 'today' o fecha ISO"),
    days: z.number().int().min(1).max(30).default(7).describe("Número de días a consultar"),
    calendarIds: z.array(z.string()).default(["primary"]).describe("Lista de IDs de calendarios a consultar"),
  },
  async ({ startDate, days, calendarIds }) => {
    const auth = getAuth();
    const timeMin = startDate === "today" ? new Date() : new Date(startDate);
    const timeMax = new Date(timeMin.getTime() + days * 86400000);

    const res = await calendar.freebusy.query({
      auth,
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: calendarIds.map(id => ({ id })),
      },
    });

    const lines = [];
    for (const [id, data] of Object.entries(res.data.calendars ?? {})) {
      lines.push(`Calendario: ${id}`);
      if (data.busy?.length) {
        data.busy.forEach(b => lines.push(`  Ocupado: ${b.start} → ${b.end}`));
      } else {
        lines.push("  Sin eventos en este período");
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") || "Sin datos." }] };
  }
);

// ── TASKS ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_task_lists",
  "Lista todas las listas de tareas de Google Tasks",
  {},
  async () => {
    const auth = getAuth();
    const res = await tasks.tasklists.list({ auth, maxResults: 100 });
    const items = res.data.items ?? [];
    if (!items.length) return { content: [{ type: "text", text: "No hay listas de tareas." }] };
    const text = items.map(l => `• ${l.title} [ID: ${l.id}]`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "list_tasks",
  "Lista las tareas de una lista de Google Tasks. Incluye completadas y ocultas por defecto para no perder datos.",
  {
    taskListId: z.string().default("@default").describe("ID de la lista de tareas ('@default' para la principal)"),
    showCompleted: z.boolean().default(true).describe("Si incluir tareas ya completadas (por defecto true)"),
    showHidden: z.boolean().default(true).describe("Si incluir tareas ocultas (por defecto true)"),
    dueMin: z.string().optional().describe("Fecha mínima de vencimiento (ISO, ej. 2025-05-01)"),
    dueMax: z.string().optional().describe("Fecha máxima de vencimiento (ISO, ej. 2025-05-31)"),
    maxResults: z.number().int().min(1).max(100).default(100).describe("Número máximo de tareas"),
  },
  async ({ taskListId, showCompleted, showHidden, dueMin, dueMax, maxResults }) => {
    const auth = getAuth();
    const res = await tasks.tasks.list({
      auth,
      tasklist: taskListId,
      showCompleted,
      showHidden,
      maxResults,
      ...(dueMin ? { dueMin: new Date(dueMin).toISOString() } : {}),
      ...(dueMax ? { dueMax: new Date(dueMax).toISOString() } : {}),
    });
    const items = res.data.items ?? [];
    if (!items.length) return { content: [{ type: "text", text: "No hay tareas en esta lista." }] };
    return { content: [{ type: "text", text: items.map(formatTask).join("\n\n") }] };
  }
);

server.tool(
  "search_tasks",
  "Busca tareas por texto en todas las listas (o una específica). Incluye completadas e historial. Usa esto cuando no sabes en qué lista está la tarea.",
  {
    query: z.string().describe("Texto a buscar en el título o notas de la tarea (insensible a mayúsculas)"),
    taskListId: z.string().default("all").describe("ID de la lista donde buscar, o 'all' para buscar en todas"),
    showCompleted: z.boolean().default(true).describe("Incluir tareas completadas"),
    showHidden: z.boolean().default(true).describe("Incluir tareas ocultas"),
  },
  async ({ query, taskListId, showCompleted, showHidden }) => {
    const auth = getAuth();

    let listIds;
    if (taskListId === "all") {
      const listsRes = await tasks.tasklists.list({ auth, maxResults: 100 });
      listIds = (listsRes.data.items ?? []).map(l => ({ id: l.id, title: l.title }));
    } else {
      listIds = [{ id: taskListId, title: taskListId }];
    }

    const needle = query.toLowerCase();
    const matches = [];

    for (const list of listIds) {
      const res = await tasks.tasks.list({
        auth, tasklist: list.id, showCompleted, showHidden, maxResults: 100,
      });
      const found = (res.data.items ?? []).filter(t =>
        (t.title ?? "").toLowerCase().includes(needle) ||
        (t.notes ?? "").toLowerCase().includes(needle)
      );
      for (const t of found) {
        matches.push(`[Lista: ${list.title}]\n${formatTask(t)}`);
      }
    }

    if (!matches.length) return { content: [{ type: "text", text: `No se encontraron tareas con "${query}".` }] };
    return { content: [{ type: "text", text: matches.join("\n\n") }] };
  }
);

server.tool(
  "get_task",
  "Obtiene los detalles completos de una tarea específica",
  {
    taskListId: z.string().default("@default").describe("ID de la lista de tareas"),
    taskId: z.string().describe("ID de la tarea (obtenido de list_tasks)"),
  },
  async ({ taskListId, taskId }) => {
    const auth = getAuth();
    const res = await tasks.tasks.get({ auth, tasklist: taskListId, task: taskId });
    const t = res.data;
    const lines = [
      `Título: ${t.title ?? "(Sin título)"}`,
      `Estado: ${t.status}`,
      t.due ? `Vence: ${t.due.slice(0, 10)}` : null,
      t.notes ? `Notas: ${t.notes}` : null,
      t.parent ? `Subtarea de: ${t.parent}` : null,
      `Actualizado: ${t.updated}`,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "analyze_events",
  "Busca eventos por nombre en todos los calendarios y devuelve estadísticas calculadas: media, total, mín, máx, número de sesiones. Ideal para analizar sueño, ejercicio u otras actividades registradas como eventos.",
  {
    query: z.string().describe("Texto a buscar en el título del evento (ej. 'Dormir', 'Correr')"),
    startDate: z.string().default("30daysago").describe("Inicio: 'today', '30daysago', o fecha ISO (ej. 2026-04-01)"),
    days: z.number().int().min(1).max(365).default(30).describe("Días desde startDate"),
    minDuration: z.number().int().min(0).default(0).describe("Ignorar eventos más cortos que este número de minutos (útil para excluir siestas)"),
  },
  async ({ query, startDate, days, minDuration }) => {
    const auth = getAuth();
    const timeMin = parseDate(startDate).toISOString();
    const timeMax = new Date(new Date(timeMin).getTime() + days * 86400000).toISOString();

    const listRes = await calendar.calendarList.list({ auth });
    const calendarIds = (listRes.data.items ?? []).map(c => c.id);

    const durations = [];
    for (const cid of calendarIds) {
      const res = await calendar.events.list({
        auth, calendarId: cid, q: query, maxResults: 500, singleEvents: true,
        timeMin, timeMax,
      });
      for (const e of res.data.items ?? []) {
        const start = e.start?.dateTime ?? e.start?.date;
        const end = e.end?.dateTime ?? e.end?.date;
        if (!start || !end) continue;
        const mins = Math.round((new Date(end) - new Date(start)) / 60000);
        if (mins >= minDuration) durations.push(mins);
      }
    }

    if (!durations.length) return { content: [{ type: "text", text: `No se encontraron eventos con "${query}" en ese período.` }] };

    const total = durations.reduce((a, b) => a + b, 0);
    const avg = Math.round(total / durations.length);
    const min = Math.min(...durations);
    const max = Math.max(...durations);

    const fmt = m => `${Math.floor(m / 60)}h ${m % 60}min`;
    const lines = [
      `Eventos analizados: ${durations.length}`,
      `Período: ${timeMin.slice(0, 10)} → ${timeMax.slice(0, 10)}`,
      minDuration > 0 ? `(Sesiones < ${fmt(minDuration)} excluidas)` : null,
      ``,
      `Media:  ${fmt(avg)} (${avg} min)`,
      `Mínimo: ${fmt(min)} (${min} min)`,
      `Máximo: ${fmt(max)} (${max} min)`,
      `Total:  ${fmt(total)} (${total} min)`,
    ].filter(l => l !== null);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
