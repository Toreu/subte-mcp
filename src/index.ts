import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// Canal público SignalR que alimenta la página de estado de líneas de Emova.
// No es una API documentada: si Emova la cambia, este conector deja de responder.
const SIGNALR_BASE =
	"https://aplicacioneswp.metrovias.com.ar/estadolineasEMOVA/signalr";
const HUB = "signalremova";
const EVENTO = "estadolineas";
const LINEAS = ["A", "B", "C", "D", "E", "H", "Premetro"] as const;
const TIEMPO_MAXIMO_MS = 15000;

type Estados = Record<string, string>;

function limpiarTexto(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function nombreDeLinea(etiqueta: string): string | undefined {
	const texto = etiqueta
		.normalize("NFC")
		.trim()
		.replace(/^l[ií]nea\s+/i, "")
		.toLowerCase();
	return LINEAS.find((linea) => linea.toLowerCase() === texto);
}

// Cada línea viene en un <div class="col"> con un <img alt="Linea X"> y un <p> con el estado.
export function parsearEstados(html: string): Estados {
	const estados: Estados = {};
	const bloques = html
		.split(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcol\b[^"']*["'][^>]*>/i)
		.slice(1);
	for (const bloque of bloques) {
		const alt = bloque.match(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["']/i)?.[1];
		const parrafo = bloque.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
		if (!alt || parrafo === undefined) continue;
		const linea = nombreDeLinea(alt);
		const estado = limpiarTexto(parrafo);
		if (linea && estado) estados[linea] = estado;
	}
	return estados;
}

function estaCompleto(estados: Estados): boolean {
	return LINEAS.every((linea) => Boolean(estados[linea]));
}

function extraerDeMensaje(datos: string): Estados | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(datos);
	} catch {
		return undefined;
	}
	const mensajes = (payload as { M?: unknown })?.M;
	if (!Array.isArray(mensajes)) return undefined;
	for (const mensaje of mensajes) {
		const { H, M, A } = (mensaje ?? {}) as { H?: unknown; M?: unknown; A?: unknown };
		if (typeof H !== "string" || H.toLowerCase() !== HUB) continue;
		if (typeof M !== "string" || M.toLowerCase() !== EVENTO) continue;
		if (Array.isArray(A) && typeof A[0] === "string") return parsearEstados(A[0]);
	}
	return undefined;
}

async function leerEstado(cuerpo: ReadableStream<Uint8Array>): Promise<Estados> {
	const lector = cuerpo.getReader();
	const decodificador = new TextDecoder();
	let pendiente = "";
	try {
		while (true) {
			const { value, done } = await lector.read();
			if (done) break;
			pendiente = (pendiente + decodificador.decode(value, { stream: true })).replace(
				/\r\n/g,
				"\n",
			);
			let corte: number;
			while ((corte = pendiente.indexOf("\n\n")) !== -1) {
				const evento = pendiente.slice(0, corte);
				pendiente = pendiente.slice(corte + 2);
				const datos = evento
					.split("\n")
					.filter((linea) => linea.startsWith("data:"))
					.map((linea) => linea.slice(5).trimStart())
					.join("\n");
				if (!datos || datos === "initialized" || datos === "{}") continue;
				const estados = extraerDeMensaje(datos);
				if (estados && estaCompleto(estados)) return estados;
			}
		}
	} finally {
		lector.cancel().catch(() => {});
	}
	throw new Error("Emova cerró la conexión sin enviar el estado de las líneas");
}

function cookiesDe(respuesta: Response): string[] {
	const encabezados = respuesta.headers as Headers & { getSetCookie?: () => string[] };
	const lista =
		typeof encabezados.getSetCookie === "function"
			? encabezados.getSetCookie()
			: [respuesta.headers.get("set-cookie") ?? ""];
	return lista.map((cookie) => cookie.split(";")[0].trim()).filter(Boolean);
}

export async function obtenerEstadoSubte(
	fetchFn: typeof fetch = fetch,
): Promise<{ estados: Estados; consultado: string }> {
	const base = new URLSearchParams({
		clientProtocol: "2.0",
		connectionData: JSON.stringify([{ name: HUB }]),
	});

	const negociacion = await fetchFn(`${SIGNALR_BASE}/negotiate?${base}&_=${Date.now()}`, {
		headers: { Accept: "application/json" },
	});
	if (!negociacion.ok) throw new Error(`Emova respondió ${negociacion.status} al negociar`);
	const cookies = cookiesDe(negociacion);
	const { ConnectionToken } = (await negociacion.json()) as { ConnectionToken?: string };
	if (!ConnectionToken) throw new Error("Emova no devolvió un token de conexión");

	const transporte = new URLSearchParams(base);
	transporte.set("transport", "serverSentEvents");
	transporte.set("connectionToken", ConnectionToken);
	const encabezados: Record<string, string> = cookies.length
		? { Cookie: cookies.join("; ") }
		: {};

	const controlador = new AbortController();
	const temporizador = setTimeout(() => controlador.abort(), TIEMPO_MAXIMO_MS);
	try {
		const conexion = await fetchFn(`${SIGNALR_BASE}/connect?${transporte}`, {
			headers: { ...encabezados, Accept: "text/event-stream" },
			signal: controlador.signal,
		});
		if (!conexion.ok || !conexion.body) {
			throw new Error(`Emova respondió ${conexion.status} al conectar`);
		}
		const inicio = await fetchFn(`${SIGNALR_BASE}/start?${transporte}`, {
			headers: encabezados,
			signal: controlador.signal,
		});
		await inicio.text();
		if (!inicio.ok) throw new Error(`Emova respondió ${inicio.status} al iniciar`);

		const estados = await leerEstado(conexion.body);
		const consultado = new Date().toLocaleString("es-AR", {
			timeZone: "America/Argentina/Buenos_Aires",
		});
		return { estados, consultado };
	} catch (error) {
		if (controlador.signal.aborted) {
			throw new Error(`Emova no envió el estado en ${TIEMPO_MAXIMO_MS / 1000} segundos`);
		}
		throw error;
	} finally {
		clearTimeout(temporizador);
		controlador.abort();
		await Promise.race([
			fetchFn(`${SIGNALR_BASE}/abort?${transporte}`, {
				method: "POST",
				headers: encabezados,
			}).catch(() => undefined),
			new Promise((resolver) => setTimeout(resolver, 2000)),
		]);
	}
}

function createServer() {
	const server = new McpServer({
		name: "Estado del subte de Buenos Aires",
		version: "1.0.0",
	});

	server.registerTool(
		"estado_subte",
		{
			description:
				"Estado actual de las líneas de subte de Buenos Aires (A, B, C, D, E, H y Premetro), " +
				"tomado del canal público de Emova que alimenta su página de estado de líneas.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { estados, consultado } = await obtenerEstadoSubte();
				const lineas = LINEAS.map((linea) => `${linea}: ${estados[linea]}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Estado del subte según Emova (consultado ${consultado}):\n${lineas}`,
						},
					],
				};
			} catch (error) {
				const motivo = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `No pude obtener el estado del subte: ${motivo}. Revisá la app de Emova.`,
						},
					],
				};
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
