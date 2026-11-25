# Conector "Estado del subte"

Conector MCP para Claude que consulta el estado de las líneas de subte de Buenos Aires
(A, B, C, D, E, H y Premetro) desde el canal público de Emova que alimenta su página de
estado de líneas. Corre gratis en Cloudflare Workers.

Importante: ese canal no es una API documentada. Si Emova lo cambia, el conector va a
responder con un error y hay que volver a la app de Emova.

## Qué necesitás

- Tu computadora personal (no la de la empresa).
- Node.js 20 o superior: https://nodejs.org
- Una cuenta gratuita de Cloudflare: https://dash.cloudflare.com/sign-up

## Pasos

1. Descomprimí esta carpeta y abrí una terminal adentro.
2. Instalá las dependencias:

   ```
   npm install
   ```

3. Conectá tu cuenta de Cloudflare (se abre el navegador para autorizar):

   ```
   npx wrangler login
   ```

4. Publicá el conector:

   ```
   npx wrangler deploy
   ```

   Al terminar te muestra una dirección del tipo
   `https://subte-mcp.TU-SUBDOMINIO.workers.dev`

5. En claude.ai, agregá un conector personalizado con esta dirección
   (la misma de arriba, terminada en `/mcp`):

   ```
   https://subte-mcp.TU-SUBDOMINIO.workers.dev/mcp
   ```

6. Avisale a Claude en el chat y lo prueba.

## Probarlo antes de conectarlo (opcional)

En https://playground.ai.cloudflare.com/ pegá la dirección terminada en `/mcp` y ejecutá
la herramienta `estado_subte`.

## Notas

- El conector no guarda datos ni pide contraseñas: solo lee el estado público del subte.
- La dirección es pública. No tiene información sensible, pero no hace falta compartirla.
- Referencia: el protocolo se tomó del proyecto abierto
  https://github.com/agmonetti/bot-subte-argentina (este código es una implementación propia).
