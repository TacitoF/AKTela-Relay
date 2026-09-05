# AKTela Relay — Stability v2.1

Relay WebSocket da AKTela em Cloudflare Workers + Durable Objects.

## Revisão v2.1

- Mantém um único publisher por sala e reconexão do mesmo Capture.
- Mantém negociação de codecs/capacidades e fallback de mídia textual para a Discord Activity.
- Preserva cache em memória do último keyframe enquanto o Durable Object está ativo; após hibernação, solicita um novo keyframe ao publisher.
- Corrige o encaminhamento do motivo real de `request-keyframe` enviado pelo espectador.
- `src/index.ts` passou por typecheck estático nesta revisão.

## Rotas

- `/health`
- `/ws`
- `/relay`
- `/relay/ws`
