# AKTela Relay — Stability v2

Relay WebSocket da AKTela em Cloudflare Workers + Durable Objects.

## Principais mudanças

- Protocolo AKV5.
- Um Durable Object por código/sala.
- Apenas um publisher por sala.
- Reconexão do mesmo publisher/viewer sem duplicar a sessão.
- Negociação agregada de codecs entre todos os espectadores.
- Cache do último keyframe enquanto o objeto está em memória; se ele hibernar, um novo keyframe é solicitado.
- WebSocket Hibernation API e auto-response `ping`/`pong`.
- Estado de cada conexão salvo em `serializeAttachment()`.
- Transporte de mídia em texto/base64 para espectadores dentro do proxy da Discord Activity; publisher continua enviando binário ao Cloudflare.

## URL

`https://aktela-relay.tacito1-filho.workers.dev/health`

## Deploy

Substitua o conteúdo do repositório `AKTela-Relay`. O deploy continua sendo:

```text
npx wrangler deploy
```
