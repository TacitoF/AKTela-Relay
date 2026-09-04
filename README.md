# AKTela Relay

Relay WebSocket do AKTela usando Cloudflare Workers + Durable Objects.

## Discord URL Mapping obrigatório
No Developer Portal, em **Atividades > Mapeamentos de URL**, mantenha:

1. `/relay` -> `aktela-relay.tacito1-filho.workers.dev`
2. `/` -> domínio da Activity na Vercel

O mapeamento `/relay` deve ficar acima de `/`.
